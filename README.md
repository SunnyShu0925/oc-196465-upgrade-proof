# openclaw PR #196465 — driver-lane upgrade proof

Published `openclaw@2026.11.2` writes the settings and auth state, the shipped
`openclaw update` moves that state to a candidate built from the reviewed head,
and the candidate Doctor then runs on the upgraded state.

`scripts/proof.sh` prints the before/after snapshots, the updater transcript, and
the agent-directory read-failure scenes. Workflow logs and artifacts carry the
raw output.
