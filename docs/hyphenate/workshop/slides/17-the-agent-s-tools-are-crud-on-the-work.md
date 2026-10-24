# 17. The agent's tools are CRUD on the work

Source: [workshop PDF, page 17](../source/workshop-slides.pdf#page=17).

[Slide index](index.md) · [Previous](16-map-who-may-do-what-to-which-record.md) · [Next](18-log-every-transition-as-a-diff.md)

**Build 3: the harness meets the application**

### Work-item lifecycle

```text
NEW                          sync: a new bank line
  |
  | propose · ai_agent
  v
PROPOSED -- ask --> NEEDS_INFO
    ^                 |
    +---- answer -----+
  |
  | approve · human_accountant
  v
APPROVED
  |
  | post · gateway -> NetSuite
  v
POSTED                       the only write to the record
```

| CRUD operation | Meaning here |
| --- | --- |
| C | Sync creates a work item per bank line |
| R | Tools read records, policies, precedents |
| U | Every change goes through `transition()` |
| D | Never: a reversal is a new transition |

```python
TRANSITIONS = {  # (state, action) -> next state
    ("NEW",        "propose"): "PROPOSED",
    ("PROPOSED",   "ask"):     "NEEDS_INFO",
    ("NEEDS_INFO", "answer"):  "PROPOSED",
    ("PROPOSED",   "approve"): "APPROVED",
    ("APPROVED",   "post"):    "POSTED",  # NetSuite
}

@tool  # the harness sees tools, not tables or keys
def propose_match(item_id, invoice_id, policy_id):
    item = work_items.read(item_id)  # R
    return transition(item, "propose", AI_AGENT,  # U
                      patch={"invoice": invoice_id,
                             "policy": policy_id},
                      reason=f"{policy_id}: gap within tolerance")
```

![Slide 17: CRUD and transitions](images/slide-17.png)
