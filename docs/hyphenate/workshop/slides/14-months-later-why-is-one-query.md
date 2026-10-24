# 14. Months later, “why?” is one query

Source: [workshop PDF, page 14](../source/workshop-slides.pdf#page=14).

[Slide index](index.md) · [Previous](13-every-correction-becomes-precedent.md) · [Next](15-sync-the-systems-of-record-into-one-shape.md)

**03: Audit trail, from day one**

### Human + system of record

February audit: why was INV-1042 closed $25 short? Oracle NetSuite shows a payment and a write-off. The why is in someone's inbox.

### AI agent + system of work

Every step was an event: the bank line, the invoice, the policy and its version, who approved, what changed. The answer is a query.

**Append-only; written with the change.**

```sql
SELECT at, actor, change, why
FROM   audit_log
WHERE  subject = 'INV-1042'
ORDER BY at;
```

| at | actor | change | why |
| --- | --- | --- | --- |
| 09:02 | `sync` | + NEW | `JPM-88310442` |
| 09:03 | `ai_agent` | → PROPOSED | `pol-001 v1`, $25 gap |
| 11:40 | `human_accountant` | → APPROVED | “intermediary fee” |
| 11:41 | `gateway` | → POSTED | NetSuite `PYMT-7781` |
| 11:41 | `gateway` | + JE | $25.00 → 6850 |

![Slide 14: An auditable answer](images/slide-14.png)
