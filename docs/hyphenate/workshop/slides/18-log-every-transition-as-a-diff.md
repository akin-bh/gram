# 18. Log every transition as a diff

Source: [workshop PDF, page 18](../source/workshop-slides.pdf#page=18).

[Slide index](index.md) · [Previous](17-the-agent-s-tools-are-crud-on-the-work.md) · [Next](19-strong-vs-weak-submissions.md)

**Build 4: permissions and traceability**

### Example event

**11:40 · `human_accountant` · approve**

| Field | Value |
| --- | --- |
| Subject | `WI-5531` · `INV-1042` |
| Diff | `state: PROPOSED → APPROVED`; `approved_by: ∅ → human_accountant` |
| Reason | “intermediary fee” |
| Evidence | `JPM-88310442`; `INV-1042`; `pol-001 v1` |

- **Append-only:** fixes are new events.
- **Same commit** as the change itself.
- **Denied attempts** are logged too.

```python
def transition(item, action, actor, patch=None, reason=""):
    to = TRANSITIONS.get((item.state, action))
    ok = to is not None and can(actor, action, item)
    before = snapshot(item)

    if ok:
        item.update(patch or {}, state=to)
    with db.transaction():  # one commit
        if ok: db.save(item)
        db.append("audit_log", dict(  # append-only
            at=now(), actor=actor.id, action=action,
            subject=item.id, allowed=ok, reason=reason,
            diff=diff(before, snapshot(item)),
            evidence=item.evidence))  # source row ids
    if not ok: raise Denied(action, item.id)
    return item
```

![Slide 18: Atomic changes and audit events](images/slide-18.png)
