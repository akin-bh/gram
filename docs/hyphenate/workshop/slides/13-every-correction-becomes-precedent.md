# 13. Every correction becomes precedent

Source: [workshop PDF, page 13](../source/workshop-slides.pdf#page=13).

[Slide index](index.md) · [Previous](12-learn-the-job-from-the-company-s-history.md) · [Next](14-months-later-why-is-one-query.md)

**02: Self-improving, every day**

### Human + system of record

Acme starts paying two invoices with one wire. She splits it by hand and remembers. When she leaves, the lesson leaves with her.

### AI agent + system of work

An accountant corrects its match. The agent finds similar corrections, spots the pattern, and proposes a general policy.

**`pol-014`: one wire, many invoices → split.**

### Agent trace

```text
human_accountant corrected WI-5602
  split one wire across INV-1077 and INV-1078

ai_agent search_precedents(customer="Acme")
  3 alike: several invoice numbers in one memo

ai_agent think
  Memo lists the invoices; amounts add up to
  the wire. Not Acme-specific: make it general.

ai_agent propose_policy
  pol-014: split a wire across every invoice
  number in its memo when the amounts add up
  evidence: prec-311, prec-318, prec-322

needs_approval · human_controller
```

![Slide 13: Corrections become precedent](images/slide-13.png)
