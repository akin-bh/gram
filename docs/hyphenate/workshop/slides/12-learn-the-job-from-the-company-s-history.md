# 12. Learn the job from the company's history

Source: [workshop PDF, page 12](../source/workshop-slides.pdf#page=12).

[Slide index](index.md) · [Previous](11-a-good-system-of-work-learns-improves-and-proves.md) · [Next](13-every-correction-becomes-precedent.md)

**01: Self-learning, at onboarding**

### Human + system of record

A new accountant shadows for two weeks, reads last year's close binders and asks: what do we do with short wires? The answer lives in her head.

### AI agent + system of work

Queries a year of Oracle NetSuite payments against J.P. Morgan lines, finds how short wires were booked, and drafts a policy.

**`pol-001`: wire ≤ $50 short → 6850 Bank Fees.**

### Agent trace

`ai_agent` / `think`: How did this team book wires that came in short?

`ai_agent` / `run_sql`:

```sql
SELECT account, COUNT(*) AS n, MAX(gap) AS max_gap
FROM   paid_invoices_vs_bank           -- 12 months
WHERE  memo LIKE 'WIRE IN %' AND gap <= 50
GROUP  BY account;
```

Result:

```text
6850 Bank Fees | 214 | 48.00
```

`ai_agent` / `propose_policy`:

```text
pol-001: wire ≤ $50 short → book gap to 6850
evidence: 214 precedents · approver: human_controller
```

Result: `needs_approval`.

![Slide 12: Learning from company history](images/slide-12.png)
