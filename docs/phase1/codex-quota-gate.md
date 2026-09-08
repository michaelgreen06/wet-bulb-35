# Codex quota gate

Run the gate immediately before **every** `delegate_task` launch:

```sh
scripts/codex-quota-gate resumable
```

Its JSON is the orchestration input. Exit `0` permits the launch; `10` means defer for quota, `11` means the task is critical and must not be delegated, and `12` means usage data was unavailable or malformed and therefore fails closed.

Risk classes are `trivial`, `resumable`, `sensitive`, and `critical`. Work whose interruption would be serious is `critical`; redesign it into bounded resumable work or execute it in the parent instead of delegating it. This gate never redeems banked resets.

When a quota deferral includes `next_eligible_at`, a later orchestration step may schedule follow-up work from that timestamp. The gate itself does not schedule jobs.
