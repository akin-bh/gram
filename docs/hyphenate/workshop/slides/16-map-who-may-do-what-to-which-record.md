# 16. Map who may do what, to which record

Source: [workshop PDF, page 16](../source/workshop-slides.pdf#page=16).

[Slide index](index.md) · [Previous](15-sync-the-systems-of-record-into-one-shape.md) · [Next](17-the-agent-s-tools-are-crud-on-the-work.md)

**Build 2: agents and humans as one team**

The slide lists three independent dimensions:

- **Actors:** sync job; AI agent; accountant; controller; gateway.
- **Actions:** create; propose; ask / answer; approve; post.
- **Resources:** bank line; invoice; work item; policy; journal.

### Our wire: checked on every call

| Actor | Action | Target | Allowed? |
| --- | --- | --- | --- |
| `sync` | create | `WI-5531` | Yes |
| `ai_agent` | propose | `WI-5531` | Yes |
| `ai_agent` | approve | `WI-5531` | No |
| `human_accountant` | approve | `WI-5531` | Yes |
| `ai_agent` | post | NetSuite | No |

```python
ROLES = {  # role -> resource -> allowed actions
    "sync":             {"work_item": {"create"}},
    "ai_agent":         {"work_item": {"propose", "ask"},
                         "policy":    {"propose"}},
    "human_accountant": {"work_item": {"approve", "answer"}},
    "human_controller": {"policy":    {"approve"}},
}  # no role can "post": only the gateway does

def can(actor, action, res) -> bool:
    if action not in ROLES[actor.role].get(res.kind, ()):
        return False
    if action == "approve" and res.proposed_by == actor.id:
        return False  # separation of duties
    return True
```

![Slide 16: Actors, actions, resources](images/slide-16.png)
