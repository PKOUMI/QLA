# Sample data

Realistic test data for the app: a full GCSE paper with a whole year group's
worth of marks. Nothing here is real — every name is invented and **no email
address can reach anybody** (see below).

| File | What it is |
|---|---|
| `gcse-science-paper-90-pupils.json` | The whole assessment: paper, boundaries, 90 pupils, every mark entered |
| `gcse-class-list-90-pupils.csv` | The same 90 pupils, for testing the class-list import on its own |
| `generate.mjs` | The script that produced both, so they can be regenerated or changed |

## Loading it

**The whole assessment** — click **Assessments** in the top right, then
**Restore from backup**, and choose `gcse-science-paper-90-pupils.json`. The
app opens on Set up with everything already filled in.

Your own work is not touched: this arrives as a separate assessment, and you
can switch between them from the same Assessments dialog.

**Just the class list** — on the Set up page, click **Import CSV** and choose
`gcse-class-list-90-pupils.csv`. Useful for exercising the CSV validation and
the duplicate handling.

## What is in it

- **GCSE Combined Science: Trilogy — Biology Paper 1**, Higher tier, 70 marks
- **30 questions** numbered the way the real paper is (`01.1`, `01.2`, `02.1`…),
  each with a topic and a reteach link
- **9 topics**: Cell biology, Organisation, Infection and response,
  Bioenergetics, Transport in cells, Enzymes, Digestion, Required practical
  skills, Maths in science
- **90 pupils**, all fully marked, 10 of them with no parent address on file
- A believable spread: mean 37.5 out of 70, range 13–57, grades from U to 8

The marks are not random. Each pupil has an ability and each question a
difficulty, so harder questions separate the class instead of everyone scoring
the same — which means the Analyse page shows something worth looking at.

## The email addresses cannot reach anyone

Every address ends in `.invalid`:

- pupils: `27surnamei@northgate-academy.invalid`
- parents: `firstname.surname@homemail.invalid`

`.invalid` is reserved by [RFC 2606](https://www.rfc-editor.org/rfc/rfc2606) as
a top-level domain that can never be registered and never resolves in DNS. Mail
to it cannot be delivered anywhere, by anyone, ever. That makes this data safe
to point at a live email backend by mistake.

Two consequences worth expecting when you do test sending:

1. Every message will **fail**, not succeed. That is the point — it exercises
   the failure reporting, and you should see each address listed as failed
   rather than quietly counted as sent.
2. Some providers count hard bounces against your sending reputation. Resend is
   fine for a handful of test sends, but do not send all 170 repeatedly. Send
   to two or three selected pupils at a time.

To test a **successful** send, change a couple of addresses to real inboxes you
own — on the Set up page, or before importing the CSV.

## Regenerating

```bash
node sample-data/generate.mjs
```

Deterministic: the same 90 pupils and the same marks every time. Edit the
`PAPER` table, the name lists or the ability spread at the top of the script to
produce a different class.
