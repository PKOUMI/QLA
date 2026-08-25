/**
 * charts.js — small, dependency-free SVG charts.
 *
 * Deliberately hand-written rather than pulling in a charting library: the
 * whole front end stays a static site with no build step, and these four chart
 * shapes are all the Analyse page needs.
 *
 * Conventions followed throughout (they are what make the charts readable):
 *   - One hue per chart. These are single-series charts, so colour carries no
 *     identity and a value-ramp would double-encode the bar length.
 *   - Thin marks, hairline grid, 4px rounded ends on the data end only.
 *   - A 2px surface-coloured gap between adjacent fills, never a border.
 *   - Values are direct-labelled, so no reader depends on a tooltip.
 *   - Every chart has a table view twin, so no value is colour-only.
 */

import { el, clear } from './ui.js';

const NS = 'http://www.w3.org/2000/svg';

/** Create an SVG element. Mirrors el() from ui.js. */
export function svg(tag, attrs = {}, ...children) {
  const node = document.createElementNS(NS, tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (value === null || value === undefined || value === false) continue;
    if (key === 'text') { node.textContent = value; continue; }
    node.setAttribute(key, String(value));
  }
  for (const child of children.flat()) {
    if (child === null || child === undefined || child === false) continue;
    node.appendChild(typeof child === 'string' ? document.createTextNode(child) : child);
  }
  return node;
}

/** Path for a rectangle rounded on the data end only. */
function barPath(x, y, w, h, r, horizontal = false) {
  const radius = Math.max(0, Math.min(r, horizontal ? w : h, (horizontal ? h : w) / 2));
  if (radius === 0 || h <= 0 || w <= 0) return `M${x},${y}h${w}v${h}h${-w}z`;
  if (horizontal) {
    // Rounded on the right-hand (value) end.
    return `M${x},${y}h${w - radius}a${radius},${radius} 0 0 1 ${radius},${radius}`
      + `v${h - radius * 2}a${radius},${radius} 0 0 1 ${-radius},${radius}h${-(w - radius)}z`;
  }
  // Rounded on the top (value) end, anchored to the baseline.
  return `M${x},${y + h}v${-(h - radius)}a${radius},${radius} 0 0 1 ${radius},${-radius}`
    + `h${w - radius * 2}a${radius},${radius} 0 0 1 ${radius},${radius}v${h - radius}z`;
}

/* --- Tooltip ------------------------------------------------------------ */

let tipNode = null;
function tooltip() {
  if (!tipNode) {
    tipNode = el('div', { class: 'viz-tip', role: 'status' });
    document.body.appendChild(tipNode);
  }
  return tipNode;
}

/**
 * Attach hover/focus feedback to a mark. Keyboard focus shows exactly what
 * hover shows, so the chart is usable without a mouse.
 */
function attachTip(node, text) {
  const show = () => {
    const tip = tooltip();
    tip.textContent = text;
    tip.classList.add('is-open');
    const box = node.getBoundingClientRect();
    const tipBox = tip.getBoundingClientRect();
    const left = box.left + box.width / 2 - tipBox.width / 2;
    tip.style.left = `${Math.max(8, Math.min(left, window.innerWidth - tipBox.width - 8))}px`;
    tip.style.top = `${Math.max(8, box.top - tipBox.height - 8)}px`;
  };
  const hide = () => { if (tipNode) tipNode.classList.remove('is-open'); };
  node.addEventListener('mouseenter', show);
  node.addEventListener('mouseleave', hide);
  node.addEventListener('focus', show);
  node.addEventListener('blur', hide);
  node.setAttribute('tabindex', '0');
  node.setAttribute('role', 'img');
  node.setAttribute('aria-label', text);
}

/* --- Responsive mounting ------------------------------------------------ */

/**
 * Render a chart into a container and redraw it when the container resizes,
 * so text stays crisp instead of being scaled by the SVG viewBox.
 */
export function mountChart(container, draw) {
  const paint = () => {
    const width = container.clientWidth;
    if (width <= 0) return;             // hidden card; nothing to draw yet
    clear(container);
    container.appendChild(draw(width));
  };
  paint();
  if (typeof ResizeObserver !== 'undefined') {
    if (container.__vizObserver) container.__vizObserver.disconnect();
    const observer = new ResizeObserver(() => paint());
    observer.observe(container);
    container.__vizObserver = observer;
  }
  return paint;
}

/**
 * Tick values for an axis counting pupils. Steps are always whole numbers —
 * "0.75 pupils" is not a thing, and a 3-pupil class must not get a 0.25 grid.
 */
function ticksFor(max, target = 4) {
  if (max <= 0) return [0, 1];
  const raw = Math.max(1, max / target);
  const magnitude = 10 ** Math.floor(Math.log10(raw));
  const step = Math.max(1, Math.ceil(
    [1, 2, 5, 10].map((m) => m * magnitude).find((candidate) => candidate >= raw) || magnitude * 10,
  ));
  const ticks = [];
  for (let value = 0; value <= max; value += step) ticks.push(value);
  if (ticks[ticks.length - 1] < max) ticks.push(ticks[ticks.length - 1] + step);
  return ticks;
}

/* --- 1. Column chart (grade distribution) ------------------------------- */

/**
 * Vertical columns for counts across ordered categories.
 * One hue: the category order is carried by the axis, not by colour.
 */
export function columnChart(width, { data, unitLabel = 'pupils', height = 260 }) {
  const padding = { top: 26, right: 12, bottom: 32, left: 34 };
  const plotW = Math.max(40, width - padding.left - padding.right);
  const plotH = height - padding.top - padding.bottom;
  const maxValue = Math.max(1, ...data.map((d) => d.value));
  const ticks = ticksFor(maxValue);
  const axisMax = ticks[ticks.length - 1] || 1;

  const slot = plotW / Math.max(1, data.length);
  const barW = Math.max(6, Math.min(56, slot - 10));   // the gap is the spacer
  const root = svg('svg', {
    class: 'viz', width, height, viewBox: `0 0 ${width} ${height}`,
    'aria-hidden': 'true', focusable: 'false',
  });

  // Recessive hairline grid, solid (never dashed).
  for (const tick of ticks) {
    const y = padding.top + plotH - (tick / axisMax) * plotH;
    root.appendChild(svg('line', {
      x1: padding.left, x2: padding.left + plotW, y1: y, y2: y, class: 'viz-grid',
    }));
    root.appendChild(svg('text', {
      x: padding.left - 8, y: y + 4, class: 'viz-tick', 'text-anchor': 'end', text: String(tick),
    }));
  }

  data.forEach((datum, index) => {
    const x = padding.left + slot * index + (slot - barW) / 2;
    const h = (datum.value / axisMax) * plotH;
    const y = padding.top + plotH - h;

    if (datum.value > 0) {
      const bar = svg('path', { d: barPath(x, y, barW, h, 4), class: 'viz-bar' });
      attachTip(bar, `${datum.label}: ${datum.value} ${unitLabel}`);
      root.appendChild(bar);
    }
    // Direct label, so the value never depends on the tooltip.
    root.appendChild(svg('text', {
      x: x + barW / 2, y: datum.value > 0 ? y - 8 : padding.top + plotH - 8,
      class: datum.value > 0 ? 'viz-value' : 'viz-value is-zero',
      'text-anchor': 'middle', text: String(datum.value),
    }));
    root.appendChild(svg('text', {
      x: x + barW / 2, y: height - padding.bottom + 20,
      class: 'viz-label', 'text-anchor': 'middle', text: datum.label,
    }));
  });

  root.appendChild(svg('line', {
    x1: padding.left, x2: padding.left + plotW,
    y1: padding.top + plotH, y2: padding.top + plotH, class: 'viz-axis',
  }));
  return root;
}

/* --- 2. Donut (grade distribution, alternative view) -------------------- */

/**
 * Ordered blue ramp. Only five steps are distinguishable against white, so
 * every segment is direct-labelled and a legend is always shown — colour is
 * never the only thing telling two grades apart.
 */
const RAMP_STEPS = 5;

/**
 * Which step of the ordered ramp a segment uses. The colours themselves live
 * in css/styles.css as .viz-ramp-0 to .viz-ramp-4, so rebranding the app
 * never means editing JavaScript.
 */
export function rampClass(index, count) {
  if (count <= 1) return 'viz-ramp-2';
  const step = Math.round((index / (count - 1)) * (RAMP_STEPS - 1));
  return `viz-ramp-${step}`;
}

/** The rendered colour of a ramp step, read from the stylesheet. */
export function rampColour(index, count) {
  const step = rampClass(index, count).replace('viz-ramp-', '');
  return getComputedStyle(document.documentElement)
    .getPropertyValue(`--viz-ramp-${step}`).trim() || '#2a78d6';
}

export function donutChart(width, { data, unitLabel = 'pupils', height = 260 }) {
  const total = data.reduce((sum, d) => sum + d.value, 0);
  const size = Math.min(width, height);
  const cx = width / 2;
  const cy = height / 2;
  const outer = size / 2 - 18;
  const inner = outer * 0.58;
  const root = svg('svg', {
    class: 'viz', width, height, viewBox: `0 0 ${width} ${height}`,
    'aria-hidden': 'true', focusable: 'false',
  });

  if (total === 0) return root;

  const gapAngle = data.length > 1 ? 0.018 : 0; // the 2px surface gap, as radians
  let angle = -Math.PI / 2;

  data.forEach((datum, index) => {
    const sweep = (datum.value / total) * Math.PI * 2;
    if (sweep <= 0) return;
    const start = angle + gapAngle / 2;
    const end = angle + sweep - gapAngle / 2;
    angle += sweep;
    if (end <= start) return;

    const large = end - start > Math.PI ? 1 : 0;
    const p = (radius, a) => `${cx + radius * Math.cos(a)},${cy + radius * Math.sin(a)}`;
    const path = svg('path', {
      d: `M${p(outer, start)}A${outer},${outer} 0 ${large} 1 ${p(outer, end)}`
        + `L${p(inner, end)}A${inner},${inner} 0 ${large} 0 ${p(inner, start)}Z`,
      class: `viz-slice ${rampClass(index, data.length)}`,
    });
    attachTip(path, `${datum.label}: ${datum.value} ${unitLabel}`);
    root.appendChild(path);

    // Label the segment only when it is big enough to hold the text.
    if (sweep > 0.38) {
      const mid = (start + end) / 2;
      const radius = (outer + inner) / 2;
      root.appendChild(svg('text', {
        x: cx + radius * Math.cos(mid), y: cy + radius * Math.sin(mid) + 4,
        class: 'viz-slice-label', 'text-anchor': 'middle', text: datum.label,
      }));
    }
  });

  root.appendChild(svg('text', {
    x: cx, y: cy - 2, class: 'viz-donut-total', 'text-anchor': 'middle', text: String(total),
  }));
  root.appendChild(svg('text', {
    x: cx, y: cy + 16, class: 'viz-donut-caption', 'text-anchor': 'middle', text: unitLabel,
  }));
  return root;
}

/* --- 3. Meter rows (topic and question performance) --------------------- */

/**
 * A ratio against a limit is a meter, not a bar chart: the track shows the
 * marks available and the fill shows the marks typically achieved. Built from
 * HTML rather than SVG so the labels wrap and stay selectable.
 */
export function meterList({ rows, emptyMessage = 'Nothing to show yet.' }) {
  if (!rows.length) return el('p', { class: 'muted small', text: emptyMessage });

  return el('div', { class: 'meters' }, rows.map((row) => {
    const clamp = (value) => Math.max(0, Math.min(1, value));
    const proportion = row.max > 0 && row.value !== null ? clamp(row.value / row.max) : 0;
    const known = row.value !== null;

    // There was a paler band here showing lowest-to-highest. On a real class
    // it filled the whole track every time — with thirty pupils somebody
    // always scores nothing and somebody always gets full marks — so it looked
    // like information and carried none. The numbers that vary are in the
    // facts row instead.
    const describeRange = row.low !== null && row.low !== undefined
      && row.high !== null && row.high !== undefined
      ? `, lowest ${row.low}, highest ${row.high}` : '';

    return el('div', { class: 'meter' },
      el('div', { class: 'meter-head' },
        el('span', { class: 'meter-label', text: row.label, title: row.label }),
        el('span', { class: 'meter-value' },
          el('strong', { text: known ? row.display : '—' }),
          el('span', { class: 'meter-outof', text: ` / ${row.max}` })),
      ),
      el('div', {
        class: 'meter-track',
        role: 'img',
        'aria-label': `${row.label}: average ${known ? row.display : 'not marked'} out of ${row.max} marks`
          + describeRange + (row.sublabel ? `, ${row.sublabel}` : ''),
      },
        el('div', { class: 'meter-fill', style: `width:${(proportion * 100).toFixed(2)}%` }),
      ),
      (row.facts && row.facts.length) || row.action || row.sublabel
        ? el('div', { class: 'meter-facts' },
          ...(row.facts || []).map((fact) => el('span', { class: 'meter-fact' },
            el('span', { class: 'k', text: `${fact.label} ` }),
            el('span', { class: 'v', text: String(fact.value) }))),
          row.sublabel ? el('span', { class: 'meter-fact is-warn', text: row.sublabel }) : null,
          row.action || null)
        : null,
    );
  }));
}

/* --- 4. Histogram (mark distribution with boundaries) ------------------- */

export function histogram(width, { values, totalMarks, boundaries = [], height = 280 }) {
  const padding = { top: 30, right: 14, bottom: 54, left: 34 };
  const plotW = Math.max(40, width - padding.left - padding.right);
  const plotH = height - padding.top - padding.bottom;
  const root = svg('svg', {
    class: 'viz', width, height, viewBox: `0 0 ${width} ${height}`,
    'aria-hidden': 'true', focusable: 'false',
  });
  if (totalMarks <= 0) return root;

  // Aim for roughly a dozen bins, snapped to a tidy width.
  const rawWidth = totalMarks / 12;
  const step = [1, 2, 5, 10, 20, 25, 50].find((s) => s >= rawWidth) || 100;
  const binCount = Math.ceil(totalMarks / step);
  const bins = Array.from({ length: binCount }, (_, i) => ({
    from: i * step, to: Math.min(totalMarks, (i + 1) * step - 1), count: 0,
  }));
  for (const value of values) {
    const index = Math.min(binCount - 1, Math.floor(value / step));
    if (bins[index]) bins[index].count += 1;
  }

  const maxCount = Math.max(1, ...bins.map((b) => b.count));
  const ticks = ticksFor(maxCount);
  const axisMax = ticks[ticks.length - 1] || 1;
  const xFor = (mark) => padding.left + (mark / totalMarks) * plotW;

  for (const tick of ticks) {
    const y = padding.top + plotH - (tick / axisMax) * plotH;
    root.appendChild(svg('line', { x1: padding.left, x2: padding.left + plotW, y1: y, y2: y, class: 'viz-grid' }));
    root.appendChild(svg('text', { x: padding.left - 8, y: y + 4, class: 'viz-tick', 'text-anchor': 'end', text: String(tick) }));
  }

  const binW = plotW / binCount;
  bins.forEach((bin, index) => {
    if (bin.count === 0) return;
    const h = (bin.count / axisMax) * plotH;
    const x = padding.left + binW * index + 1;      // 2px total gap between bins
    const bar = svg('path', { d: barPath(x, padding.top + plotH - h, Math.max(2, binW - 2), h, 4), class: 'viz-bar' });
    attachTip(bar, `${bin.from}–${bin.to} marks: ${bin.count} pupil${bin.count === 1 ? '' : 's'}`);
    root.appendChild(bar);
  });

  // Grade boundaries as solid hairline rules with their grade above.
  boundaries
    .filter((b) => Number.isFinite(Number(b.minMark)) && Number(b.minMark) > 0 && Number(b.minMark) <= totalMarks)
    .forEach((boundary) => {
      const x = xFor(Number(boundary.minMark));
      root.appendChild(svg('line', {
        x1: x, x2: x, y1: padding.top - 8, y2: padding.top + plotH, class: 'viz-boundary',
      }));
      root.appendChild(svg('text', {
        x, y: padding.top - 12, class: 'viz-boundary-label', 'text-anchor': 'middle', text: boundary.grade,
      }));
    });

  root.appendChild(svg('line', {
    x1: padding.left, x2: padding.left + plotW, y1: padding.top + plotH, y2: padding.top + plotH, class: 'viz-axis',
  }));
  [0, Math.round(totalMarks / 2), totalMarks].forEach((mark) => {
    root.appendChild(svg('text', {
      x: xFor(mark), y: padding.top + plotH + 18, class: 'viz-label', 'text-anchor': 'middle', text: String(mark),
    }));
  });
  root.appendChild(svg('text', {
    x: padding.left + plotW / 2, y: height - 8, class: 'viz-axis-title', 'text-anchor': 'middle',
    text: 'Total marks',
  }));
  return root;
}

/** A legend. Always rendered for the donut, so identity is never colour-alone. */
export function legend(items) {
  return el('ul', { class: 'viz-legend' }, items.map((item) => el('li', {},
    el('span', { class: 'viz-swatch', style: `background:${item.colour}` }),
    el('span', { text: item.label }),
  )));
}

/** The table-view twin every chart needs. */
export function dataTable(headers, rows) {
  return el('div', { class: 'table-wrap' },
    el('table', { class: 'data-table compact' },
      el('thead', {}, el('tr', {}, headers.map((h, i) => el('th', { class: i ? 'num' : '', text: h })))),
      el('tbody', {}, rows.map((row) => el('tr', {}, row.map((cell, i) => el('td', { class: i ? 'num' : '', text: String(cell) }))))),
    ));
}
