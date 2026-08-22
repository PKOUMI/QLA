/**
 * Generates a realistic GCSE Combined Science Biology Paper 1 assessment.
 * Deterministic: same output every run, so the file can be regenerated.
 */
import { writeFileSync } from 'node:fs';

// --- deterministic RNG so the sample never changes between runs ---
let seed = 20260821;
const rnd = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
const normal = () => (rnd() + rnd() + rnd() + rnd() - 2) / 1.15;   // ~N(0,1), bounded

/* --- The paper ---------------------------------------------------------
 * AQA-style Combined Science: Trilogy, Biology Paper 1, Higher tier.
 * 70 marks, numbered the way the paper is (01.1, 01.2 ... ) so the free-text
 * question numbers get a proper workout.
 * -------------------------------------------------------------------- */
const TOPICS = {
  cells: { name: 'Cell biology', url: 'https://example.com/revision/cell-biology' },
  org: { name: 'Organisation', url: 'https://example.com/revision/organisation' },
  infect: { name: 'Infection and response', url: 'https://example.com/revision/infection-and-response' },
  bio: { name: 'Bioenergetics', url: 'https://example.com/revision/bioenergetics' },
  transport: { name: 'Transport in cells', url: 'https://example.com/revision/transport-in-cells' },
  enzymes: { name: 'Enzymes', url: 'https://example.com/revision/enzymes' },
  digestion: { name: 'Digestion', url: 'https://example.com/revision/digestion' },
  practical: { name: 'Required practical skills', url: 'https://example.com/revision/required-practicals' },
  maths: { name: 'Maths in science', url: 'https://example.com/revision/maths-skills' },
};

// [number, marks, topic key, difficulty 0-1 : higher = harder]
const PAPER = [
  ['01.1', 1, 'cells', 0.15], ['01.2', 2, 'cells', 0.25], ['01.3', 2, 'cells', 0.40],
  ['01.4', 3, 'cells', 0.55], ['01.5', 4, 'cells', 0.70],
  ['02.1', 1, 'transport', 0.20], ['02.2', 2, 'transport', 0.45], ['02.3', 3, 'transport', 0.60],
  ['02.4', 4, 'practical', 0.65],
  ['03.1', 2, 'enzymes', 0.30], ['03.2', 2, 'enzymes', 0.50], ['03.3', 3, 'enzymes', 0.70],
  ['03.4', 1, 'maths', 0.35], ['03.5', 3, 'maths', 0.75],
  ['04.1', 1, 'digestion', 0.20], ['04.2', 2, 'digestion', 0.40], ['04.3', 4, 'digestion', 0.60],
  ['05.1', 1, 'org', 0.15], ['05.2', 2, 'org', 0.35], ['05.3', 3, 'org', 0.55], ['05.4', 4, 'org', 0.75],
  ['06.1', 1, 'infect', 0.20], ['06.2', 2, 'infect', 0.40], ['06.3', 2, 'infect', 0.50],
  ['06.4', 4, 'infect', 0.70],
  ['07.1', 1, 'bio', 0.25], ['07.2', 2, 'bio', 0.45], ['07.3', 3, 'bio', 0.60],
  ['07.4', 2, 'practical', 0.55], ['07.5', 3, 'bio', 0.80],
];

const totalMarks = PAPER.reduce((sum, q) => sum + q[1], 0);

/* --- The class --------------------------------------------------------- */
const FIRST = ['Aaliyah','Adam','Aisha','Alex','Alfie','Amara','Amelia','Amir','Archie','Arthur',
  'Ava','Ayesha','Blake','Bobby','Callum','Caitlin','Charlie','Chloe','Connor','Daisy','Daniel',
  'Darcie','Dev','Eesa','Eleanor','Elijah','Ellie','Emily','Erin','Ethan','Evie','Ezra','Farhan',
  'Finlay','Florence','Freya','George','Grace','Gurpreet','Hannah','Harley','Harper','Harry',
  'Hassan','Heidi','Hugo','Ibrahim','Imogen','Isaac','Isla','Ivy','Jack','Jacob','Jasmine','Joel',
  'Josie','Kai','Keira','Khadija','Lacey','Leo','Lewis','Lily','Logan','Lucas','Maisie','Malachi',
  'Maryam','Mason','Matilda','Maya','Mia','Milo','Mohammed','Nancy','Nathan','Niamh','Noah','Olivia',
  'Oscar','Paige','Poppy','Rafferty','Reuben','Rhys','Riley','Rosie','Ruby','Sana','Scarlett','Seth',
  'Sienna','Sofia','Stanley','Tegan','Theo','Thomas','Tommy','Willow','Yusuf','Zara','Zach'];
const LAST = ['Abbott','Ahmed','Ali','Andrews','Bailey','Baker','Bennett','Blake','Booth','Bradley',
  'Brennan','Brooks','Burns','Campbell','Carter','Chapman','Clarke','Coleman','Collins','Cooper',
  'Cox','Craig','Cunningham','Dawson','Dean','Dixon','Doyle','Ellis','Evans','Fisher','Fletcher',
  'Ford','Foster','Fraser','Gallagher','Gibson','Graham','Griffiths','Hall','Hardy','Harper',
  'Hayes','Hilton','Hughes','Hunter','Iqbal','Jenkins','Johnson','Kaur','Kelly','Khan','Lawson',
  'Leach','Lloyd','Lowe','Marsh','Mason','McKenzie','Mills','Mitchell','Moore','Morgan','Murphy',
  'Murray','Nelson','Newton','Norton','Nowak','O’Brien','Osborne','Owens','Parry','Patel',
  'Payne','Pearson','Phillips','Pierce','Quinn','Reid','Reynolds','Richards','Roberts','Russell',
  'Shah','Sharpe','Simpson','Sinclair','Slater','Stone','Sutton','Taylor','Thomson','Vaughan',
  'Walsh','Ward','Webb','Whitaker','Wilkinson','Wright','Yates','Young'];

// RFC 2606 reserves .invalid: it can never be registered and DNS never resolves
// it, so nothing sent to these addresses can ever reach a real person.
const SCHOOL_DOMAIN = 'northgate-academy.invalid';
const PARENT_DOMAIN = 'homemail.invalid';

const used = new Set();
const takenEmails = new Set();
function makePupil(index) {
  let first; let last; let key;
  do {
    first = FIRST[Math.floor(rnd() * FIRST.length)];
    last = LAST[Math.floor(rnd() * LAST.length)];
    key = `${first} ${last}`;
  } while (used.has(key));
  used.add(key);

  const slug = (t) => t.toLowerCase().normalize('NFD').replace(/[^a-z]/g, '');
  const year = 27;  // the year they leave, as most schools format it

  // Two pupils can share a surname and an initial, so the school's convention
  // has to break the tie — exactly as a real MIS does. The app's own duplicate
  // check found this when the first draft of this data was imported.
  const stem = `${year}${slug(last)}${slug(first)[0]}`;
  let localPart = stem;
  let suffix = 1;
  while (takenEmails.has(localPart)) { suffix += 1; localPart = `${stem}${suffix}`; }
  takenEmails.add(localPart);

  // Parent addresses collide the same way, and must also be unique.
  let parentEmail = '';
  if (rnd() < 0.87) {
    const parentStem = `${slug(first)}.${slug(last)}`;
    let parentLocal = parentStem;
    let parentSuffix = 1;
    while (takenEmails.has(parentLocal)) { parentSuffix += 1; parentLocal = `${parentStem}${parentSuffix}`; }
    takenEmails.add(parentLocal);
    parentEmail = `${parentLocal}@${PARENT_DOMAIN}`;
  }

  return {
    id: `p_${String(index + 1).padStart(3, '0')}`,
    name: key,
    email: `${localPart}@${SCHOOL_DOMAIN}`,
    parentEmail,
  };
}

const pupils = Array.from({ length: 90 }, (_, i) => makePupil(i));

/* --- The marks ---------------------------------------------------------
 * Each pupil gets an ability score; each question a difficulty. The chance of
 * scoring each mark falls away as difficulty outstrips ability, which produces
 * the shape a real class has: a fat middle, a thin tail at each end, and
 * questions that discriminate rather than everyone scoring the same.
 * -------------------------------------------------------------------- */
const marks = {};
for (const pupil of pupils) {
  const ability = 0.46 + normal() * 0.26;          // a genuinely mixed Higher set
  marks[pupil.id] = {};
  PAPER.forEach(([number, max, , difficulty], qIndex) => {
    const edge = ability - difficulty * 0.42;
    const chance = Math.max(0.02, Math.min(0.99, edge + 0.30 + normal() * 0.12));
    let scored = 0;
    for (let m = 0; m < max; m += 1) {
      // Later marks on a question are harder to reach than the first.
      if (rnd() < chance * (1 - m * 0.07)) scored += 1;
    }
    marks[pupil.id][`q_${String(qIndex + 1).padStart(2, '0')}`] = scored;
  });
}

/* --- Assemble ---------------------------------------------------------- */
const assessment = {
  schemaVersion: 3,
  id: 'asmt_sample_gcse_bio_p1',
  createdAt: '2026-05-12T09:00:00.000Z',
  updatedAt: '2026-05-12T16:30:00.000Z',
  exam: {
    name: 'GCSE Combined Science: Trilogy — Biology Paper 1',
    subject: 'Combined Science',
    teacherEmail: `science.dept@${SCHOOL_DOMAIN}`,
    date: '2026-05-12',
    paperType: 'higher',
    blankPolicy: 'incomplete',
  },
  questions: PAPER.map(([number, maxMarks, topicKey], i) => ({
    id: `q_${String(i + 1).padStart(2, '0')}`,
    number,
    maxMarks,
    topic: TOPICS[topicKey].name,
    reteachUrl: TOPICS[topicKey].url,
  })),
  // Plausible Higher-tier boundaries for a 70-mark Biology paper.
  gradeBoundaries: [
    { grade: 'U', minMark: 0 }, { grade: '3', minMark: 16 }, { grade: '4', minMark: 23 },
    { grade: '5', minMark: 30 }, { grade: '6', minMark: 37 }, { grade: '7', minMark: 44 },
    { grade: '8', minMark: 51 }, { grade: '9', minMark: 58 },
  ],
  pupils,
  marks,
  feedback: { sendToParents: false, selectedPupilIds: [], parentSelectedPupilIds: [] },
  settings: {
    lock: { enabled: false, pinHash: null, salt: null },
    analyse: {
      charts: { gradeDistribution: true, topicPerformance: true, questionAverages: true, markDistribution: true },
      gradeChartType: 'bar',
      topicSort: 'weakest',
    },
  },
  emailText: {},
  pupilEmailText: {},
  sendLog: [],
};

writeFileSync('sample-data/gcse-science-paper-90-pupils.json', JSON.stringify(assessment, null, 2));

// The same class as a CSV, for testing the class-list import on its own.
const csv = ['Name,Pupil Email,Parent Email']
  .concat(pupils.map((p) => `"${p.name}",${p.email},${p.parentEmail}`))
  .join('\r\n');
writeFileSync('sample-data/gcse-class-list-90-pupils.csv', `${csv}\r\n`);

/* --- Report ------------------------------------------------------------ */
const totals = pupils.map((p) => Object.values(marks[p.id]).reduce((a, b) => a + b, 0));
const gradeOf = (m) => [...assessment.gradeBoundaries].reverse().find((b) => m >= b.minMark).grade;
const counts = {};
for (const t of totals) counts[gradeOf(t)] = (counts[gradeOf(t)] || 0) + 1;
console.log('Paper total:', totalMarks, 'marks over', PAPER.length, 'questions');
console.log('Pupils:', pupils.length, '| without a parent email:', pupils.filter((p) => !p.parentEmail).length);
console.log('Mark range:', Math.min(...totals), '-', Math.max(...totals),
  '| mean', (totals.reduce((a, b) => a + b, 0) / totals.length).toFixed(1));
console.log('Grades:', assessment.gradeBoundaries.map((b) => `${b.grade}:${counts[b.grade] || 0}`).join('  '));
