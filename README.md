# IMS — Intelligent Meta Scheduler

A zero-dependency web simulator of low-level hardware resource allocation,
driven end-to-end by **reinforcement learning**. Heterogeneous processes flow
through a scheduler into a **4 × 3 resource grid** (4 units each of CPU, GPU
and NVMe), and a Q-learning agent — the *intelligent meta scheduler* — sits
as middleware between the scheduler and the hardware, learning where each
kind of work runs best.

```
 ┌──────────────┐   ┌─────────────┐   ┌──────────────────────┐   ┌─────────────────┐
 │ ① Process    │──▶│ ② Scheduler │──▶│ ③ INTELLIGENT META   │──▶│ ④ Resource Grid │
 │   Generator  │   │    Queue    │   │    SCHEDULER (RL)    │   │  4 rows × 3 cols│
 │ 4 workload   │   │ FIFO with   │   │ Q-learning agent:    │   │ CPU │ GPU │ NVMe│
 │ classes      │   │ backfilling │   │ state→action→reward  │   │ row0 = enclave ⛨│
 └──────────────┘   └─────────────┘   └──────────▲───────────┘   └────────┬────────┘
                                                 │        reward signal   │
                                                 └────────────────────────┘
```

## Run it

No build, no install:

```bash
python3 -m http.server 8000        # or: npx serve
# open http://localhost:8000
```

Headless verification (the engine is DOM-free):

```bash
node tests/smoke.js
```

The smoke test runs 30 000 ticks and asserts that the RL scheduler learns the
correct hardware affinities and beats round-robin on completions, efficiency
and security violations on **identical arrivals**.

## The hardware model (column behaviour)

Each of the 12 units mimics real low-level behaviour:

| | CPU | GPU | NVMe |
|---|---|---|---|
| base speed | 5 work/tick | 12 work/tick | 9 work/tick |
| slots (concurrency) | 3 | 2 | 4 |
| power draw | 10–65 W | 15–250 W | 5–25 W |
| heats up | moderately | fast | slowly |
| special | — | — | **write wear** accumulates |

- **Contention** — a unit's speed is shared between co-resident jobs.
- **Thermals** — load raises temperature; above **85 °C** the unit throttles
  to 55 % speed (cell turns red, `THROTTLE` badge appears).
- **Wear** — NVMe units accumulate flash wear from writes (visible wear bar).
- **Security** — row 0 of every column is a **secure enclave** (⛨, isolated
  partition). SECURE processes placed anywhere else count as a violation.

## The workload model (process types)

| type | behaviour | runs best on |
|---|---|---|
| ⚙ COMPUTE | branchy / serial integer work | CPU (affinity 1.0) |
| ⧉ PARALLEL | vectorizable SIMD kernels | GPU (affinity 1.0) |
| ⇆ I/O | storage-bound streams | NVMe (affinity 1.0) |
| ⛨ SECURE | crypto / attested work | CPU **enclave** |

Affinity = fraction of a column's base speed the class achieves there — the
agent is **never told this table**; it discovers it from reward alone.

## The RL formulation (the hero)

| element | definition |
|---|---|
| **State** | `(process type, CPU-load bucket, GPU-load bucket, NVMe-load bucket)` — 4 × 3³ = 108 states |
| **Actions** | dispatch to `CPU` / `GPU` / `NVME` (full columns masked), plus a **WAIT** action under grid pressure — learned admission control |
| **Reward** | weighted blend, each term ∈ ≈[−1, 1]:<br>• **throughput** — inverse slowdown vs ideal placement<br>• **efficiency** — affinity match discounted by power draw<br>• **security** — +1 enclave-compliant SECURE, −1 violation<br>• **hw health** — penalty for time spent throttled + wear added |
| **Algorithm** | tabular Q-learning, ε-greedy with decay (ε 1.0 → 0.05), α = 0.15, γ = 0.9 |
| **Credit** | one-step update fired when the process completes |

Two engines run in lock-step on **byte-identical arrival streams** (seeded
RNG): one scheduled by the agent, one by round-robin. The latency chart and
the *vs Round-Robin* KPI are therefore a controlled experiment, not an
anecdote. Typical converged results (30 k ticks):

| | RL meta-scheduler | round-robin |
|---|---|---|
| avg latency | **~1 s** | ~11 s |
| efficiency | **~64 %** | ~41 % |
| security violations | **~37** | ~890 |
| work completed | **+6 %** | — |

### What to watch in a demo

1. **ε bar drains** — the agent shifts from EXPLORE (orange) to EXPLOIT (green).
2. **Policy heatmap converges** — within a minute the ★ settles on
   COMPUTE→CPU, PARALLEL→GPU, I/O→NVMe, SECURE→CPU.
3. **Latency chart splits** — green (RL) drops, grey (round-robin) climbs.
4. **Inject a burst** (e.g. *+6 PARALLEL*) — watch the agent route the whole
   burst to the GPU column.
5. **Hit ⟲ Reset Learning** — the policy collapses and visibly relearns.
6. **Drag the reward weights** — crank *security* to 2.0 and violations stop;
   zero *hw health* and the GPUs run hot. The objective is live-tunable.

## Functional parameters

Everything the allocation depends on is exposed in `js/config.js` and most of
it on the left-hand control panel: arrival rate, α, γ, the four reward
objective weights, and sim speed. Hardware specs, affinities, thermal/wear
constants and the workload mix live in the same file.

## Code map

```
index.html        layout: generator → queue → brain → 4×3 grid → charts
css/styles.css    dark ops-console theme
js/config.js      every tunable parameter + hardware/workload specs
js/agent.js       Q-learning agent, state encoding, baseline policies
js/engine.js      hardware sim: contention, thermals, wear, power, rewards
js/charts.js      canvas line charts + learned-policy heatmap
js/ui.js          DOM construction and per-frame updates
js/main.js        wiring, controls, animation loop
tests/smoke.js    headless Node verification of the learning outcome
```

## Next step: scaling to HPC

The architecture is deliberately HPC-shaped:

- **Hierarchical actions** — the agent already picks a *column* (resource
  class) while a deterministic dispatcher picks the *unit*. Scaling out means
  adding levels (cluster → rack → node → device) without exploding the action
  space.
- **Backfilling** — the queue scan implemented here is exactly the
  backfilling used by SLURM/PBS; the WAIT action is learned admission control.
- **State generalisation** — swap the tabular Q for a small DQN / linear
  function approximator when the grid grows beyond a few hundred load buckets;
  the reward machinery is unchanged.
- **Multi-tenancy & security** — the enclave row generalises to partitioned
  nodes, SR-IOV slices and attestation-required jobs.
- **Hardware proficiency** — the thermal/wear signals map directly to real
  telemetry (RAPL, NVML, SMART), so the same reward terms apply on metal.
- **Federated agents** — one agent per rack with a shared replay buffer is
  the natural next experiment; the lock-step shadow baseline generalises to
  A/B-testing schedulers on mirrored job streams.
