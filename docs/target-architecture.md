# # 1\. Plan mode: target architecture before any new implementation

## 1.1 Architectural principle

The system must be built as a **pipeline of independent modules**, not as one growing dashboard.

The core rule is:
1. **Perception modules** detect and track vehicles.
2. **Spatial logic modules** translate detections into business meaning.
3. **State/KPI modules** compute occupancy, counts, and timelines.
4. **Interface modules** render state, not raw detector output.
5. **Observability modules** watch everything.
6. **ML quality modules** evaluate whether the model and data are still trustworthy.

⠀
This is the only professional way to keep the system modifiable.

⸻

## 1.2 What already exists and how to reinterpret it

Your current dashboard is not useless at all. It already contains the seed of feature 3.

What already exists, conceptually:
1. **Camera-space bay editor**
   * users draw bay polygons on the surveillance frame
2. **Model-space renderer**
   * bays are mirrored in a schematic layout
3. **Bay state color logic**
   * red = occupied
   * blue = free

⠀
This means that the project already has a **partial spatial configuration layer** and a **partial visualization layer**.

What it does **not** yet have, professionally:
	1. a versioned spatial configuration source of truth
	2. automatic perception pipeline
	3. tracking-based event logic
	4. zone-level aggregation
	5. entry/exit line logic
	6. historical storage
	7. alert engine
	8. runtime observability
	9. ML quality / drift monitoring

⠀	10.	strict separation between:

* UI logic
* business state
* perception output

⠀
So the first major architectural move is:

Convert the current dashboard from “the app” into two modules:
1. a **Spatial Configuration Editor**
2. a **Live Operations Dashboard**

⠀
That split is fundamental.

⸻

## 1.3 Final module map

Below is the system that should exist when features 1–8 are complete.

### A. Spatial Configuration Layer
1. **Spatial Config Editor**
   * Purpose:
     * create and edit:
       * bay polygons
       * zone polygons
       * entry lines
       * exit lines
       * optional lane / holding / cluster regions
   * Starts from the current dashboard capability
2. **Spatial Config Repository**
   * Purpose:
     * persist configuration outside the frontend
     * version every camera layout
     * expose read-only configs to runtime modules
3. **Spatial Validation Module**
   * Purpose:
     * verify geometry consistency
     * reject broken configurations

⠀
### B. Video and Inference Layer
4. **Video Ingestion Module**
   * Purpose:
     * read live stream or replayed video
     * normalize frame format
     * timestamp frames
     * detect dropped frames / lag
5. **Detection Module**
   * Purpose:
     * run pretrained vehicle detector
   * Suggested first baseline:
     * YOLO11s
   * Suggested second benchmark:
     * YOLO26s after the pipeline works end to end. Ultralytics supports model benchmarking and export workflows for this type of comparison.  
6. **Tracking Module**
   * Purpose:
     * assign stable IDs across frames
   * Suggested order:
     * ByteTrack first
     * BoT-SORT only if ID stability is insufficient. Ultralytics’ tracking docs support both.  

⠀
### C. Spatial Semantics Layer
	7. **Association Module**
	* Purpose:
		* assign tracked vehicles to:
			* bays
			* zones
			* crossing lines
	* Suggested tool:
		* Supervision PolygonZone / LineZone. LineZone explicitly uses tracker IDs.  
	8. **Bay Occupancy Engine**
	* Purpose:
		* determine whether each bay is occupied
	9. **Zone Occupancy Engine**
	* Purpose:
		* compute:
			* occupied bays per zone
			* available bays per zone
			* occupancy percentage per zone

⠀	10.	**Flow Counting Engine**
	* Purpose:
		* compute entry and exit counts
		* create crossing events

⠀
### D. Operational State Layer
	11.	**State Store**
	* Purpose:
		* store current canonical operational state
		* this is what the dashboard reads

⠀	12.	**Historical Timeline Store**
	* Purpose:
		* store recent KPI history
		* power short historical trends

⠀	13.	**Alert Engine**
	* Purpose:
		* evaluate thresholds
		* emit alert events

⠀
### E. Interface Layer
	14.	**Live Operations Dashboard**
	* Purpose:
		* show:
			* live camera
			* bay states
			* zone cards
			* counts
			* alert states
			* short historical trends

⠀	15.	**Realtime Delivery API**
	* Purpose:
		* push current state and events to the dashboard
		* keep frontend dumb and consistent

⠀
### F. Cross-Cutting Quality Layer
	16.	**Observability Module**
	* Purpose:
		* traces, metrics, logs
		* latency, dropped frames, detector timings, API errors, state inconsistencies

⠀
* Suggested stack:
  * OpenTelemetry + Prometheus + Grafana. OpenTelemetry is vendor-neutral instrumentation for traces, metrics, and logs; Prometheus records numeric time series; Grafana provides dashboards and alerting.  

⠀
	17.	**ML Quality & Drift Module**
	* Purpose:
		* detect:
			* input drift
			* prediction drift
			* performance drift
		* compare current data/predictions against a reference set

⠀
* Suggested tools:
  * CVAT for the gold evaluation subset
  * FiftyOne for evaluation / error analysis
  * Evidently for drift monitoring and reporting.  

⠀
	18.	**Replay & Evaluation Harness**
	* Purpose:
		* deterministic testing on recorded clips
		* this is mandatory, otherwise you will debug on live video forever

⠀
⸻

## 1.4 Relationship map

The relationships must be exactly this:
	1. **Spatial Config Editor**

⠀-> writes to **Spatial Config Repository**
	2. **Video Ingestion**

⠀-> sends frames to **Detection**
	3. **Detection**

⠀-> sends detections to **Tracking**
	4. **Tracking**

⠀-> sends tracked objects to **Association Module**
	5. **Association Module**

⠀-> sends bay membership to **Bay Occupancy Engine**
-> sends zone membership to **Zone Occupancy Engine**
-> sends crossing events to **Flow Counting Engine**
	6. **Bay Occupancy Engine** and **Zone Occupancy Engine**

⠀-> write canonical current state to **State Store**
	7. **Flow Counting Engine**

⠀-> writes counters and events to **State Store** and **Historical Timeline Store**
	8. **Alert Engine**

⠀-> reads KPI state
-> writes alert events
	9. **Live Operations Dashboard**

⠀-> reads only from **Realtime Delivery API / State Store**
-> never directly from detector/tracker
	10.	**Observability Module**
-> instruments every module
	11.	**ML Quality & Drift Module**
-> reads sampled inputs, predictions, KPIs, and reference sets

This separation is non-negotiable.

⸻

## 1.5 Canonical contracts the developer must respect

The developer must define these contracts before building anything new.

### Contract 1: Spatial configuration

Must include:
1. camera ID
2. frame width / height
3. bay definitions
4. zone definitions
5. line definitions
6. zone-to-bay membership
7. config version
8. activation status

⠀
### Contract 2: Detection output

Must include:
1. frame ID
2. timestamp
3. bounding box
4. class
5. confidence

⠀
### Contract 3: Track output

Must include:
1. frame ID
2. timestamp
3. track ID
4. current bbox
5. class
6. confidence
7. age / persistence metadata

⠀
### Contract 4: Bay state

Must include:
1. bay ID
2. occupied/free
3. confidence
4. last changed time
5. source track ID(s) if applicable

⠀
### Contract 5: Zone KPI state

Must include:
1. zone ID
2. total bays
3. occupied bays
4. available bays
5. occupancy percentage
6. last updated time

⠀
### Contract 6: Flow event

Must include:
1. line ID
2. event type
   * entry or exit
3. track ID
4. timestamp
5. direction
6. confidence / validity flag

⠀
### Contract 7: Alert event

Must include:
1. alert ID
2. source KPI
3. threshold rule
4. severity
5. active/inactive
6. first seen
7. last evaluated
8. explanation text

⠀
### Contract 8: Observability event/metric naming

Must be standardized from the beginning, otherwise monitoring becomes garbage.

⸻

## 1.6 Architectural decisions that must be frozen now

The developer must freeze these decisions before implementation:
1. **Single-camera logic only**
   * no multi-camera identity association yet
2. **Vehicle-only scope**
   * car, van, truck, motorcycle if useful
   * do not expand classes unnecessarily
3. **Bay occupancy is atomic**
   * zone occupancy is derived from bays when bays exist
4. **If a zone has no explicit bays**
   * zone occupancy may be estimated from tracked vehicles in the polygon
5. **Frontend is not the source of truth**
   * backend state is the source of truth
6. **All business logic stays server-side**
   * counting, occupancy, alerting must never live only in the frontend
7. **Optimization is postponed**
   * no TensorRT/OpenVINO until correctness is proven, even though both are valid deployment optimizers later.  

⠀
⸻

# 2\. Strict temporal ordered instruction sheet for one developer

Now I switch from architecture mode to execution mode.

The order below is strict.
Do not skip steps.
Do not develop later modules before earlier gates pass.

⸻

## Phase 0. Freeze scope and create the system skeleton

### Step 0.1
1. Create a written project scope document.
2. Explicitly list the only target features:
   1. vehicle detection
   2. lightweight multi-object tracking
   3. camera-to-zone mapping
   4. occupancy / available-space estimation by zone
   5. entry/exit counting
   6. live dashboard with status cards + timeline
   7. threshold-based alert engine
   8. short historical trends
3. Explicitly list what is out of scope:
   * forecasting
   * anomaly detection
   * recommendations
   * multi-camera re-identification
   * advanced routing optimization
   * automatic camera calibration

⠀
### Step 0.2
1. Split the current system mentally and structurally into:
   1. Spatial Config Editor
   2. Live Operations Dashboard
2. Make this split visible in the repository structure and internal design.

⠀
### Step 0.3
1. Define the module folders/services before coding logic:
   1. spatial-config
   2. video-ingestion
   3. detection
   4. tracking
   5. association
   6. occupancy
   7. flow-counting
   8. state-store
   9. historical-store

⠀	10.	alerts
	11.	realtime-api
	12.	observability
	13.	ml-quality
	14.	replay-eval

### Supervisor gate for Phase 0

The project fails this phase if:
1. the current dashboard still mixes editor logic and live logic
2. modules are not separated
3. scope is still fuzzy
4. frontend is still implicitly the system of record

⠀
⸻

## Phase 1. Establish contracts and observability first

This phase comes before detector integration because otherwise the developer will build opaque spaghetti.

### Step 1.1
1. Define all canonical contracts listed above.
2. Store them in a shared specification file.
3. Make every later module conform to them.

⠀
### Step 1.2
1. Add runtime observability scaffolding to every module from day one.
2. Instrument:
   1. traces
   2. logs
   3. metrics
3. Use OpenTelemetry for instrumentation because it is designed exactly for emitting traces, metrics, and logs from instrumented components.  

⠀
### Step 1.3

Expose Prometheus metrics for at least:
	1. input FPS
	2. dropped frames
	3. detector latency
	4. tracker latency
	5. end-to-end state update latency
	6. API response latency
	7. active tracks
	8. active alerts
	9. state inconsistency count

⠀	10.	processing error count

Prometheus is appropriate here because it is explicitly built for numeric time series and highly dynamic service-oriented environments.  

### Step 1.4

Create Grafana dashboards for:
1. system health
2. inference performance
3. application errors
4. data pipeline delays

⠀
Grafana dashboards and Grafana Alerting are directly intended for this style of operational monitoring.  

### Supervisor gate for Phase 1

The phase passes only if:
1. every module can emit metrics/logs/traces
2. one can already see:
   * latency
   * errors
   * dropped frames
3. a failure in one module is observable from outside
4. contract names are frozen

⠀
⸻

## Phase 2. Turn the existing dashboard into a proper spatial configuration system

This is the first place where you directly build on the current project.

### Step 2.1

Refactor the current bay polygon editor into a **Spatial Config Editor**.

It must support:
1. bay polygons
2. zone polygons
3. entry lines
4. exit lines
5. zone labels
6. bay-to-zone membership

⠀
### Step 2.2

Persist configurations into a **Spatial Config Repository**.

Every saved config must include:
1. camera identifier
2. resolution
3. version number
4. created time
5. updated time
6. status:
   * draft
   * active
   * archived

⠀
### Step 2.3

Add spatial validation rules.

A config must be rejected if:
1. a bay polygon is self-intersecting
2. a bay has no assigned zone
3. entry/exit lines are missing for a counting-enabled camera
4. polygons fall outside frame bounds
5. duplicate IDs exist

⠀
### Step 2.4

Preserve the existing model-space rendering, but change its source.

It must no longer depend on ad hoc frontend state.
It must render from persisted spatial config + runtime operational state.

### Supervisor gate for Phase 2

The phase passes only if:
1. a camera layout can be saved and reloaded
2. the model-space view renders from persisted config
3. bays, zones, and lines all exist as formal objects
4. the current bay editor is no longer a fragile UI-only feature

⠀
⸻

## Phase 3. Create the replay harness and a gold evaluation subset

This phase is mandatory.
Without it, every future debug loop will be chaotic.

### Step 3.1

Collect a small but representative set of recorded clips.

Must include:
1. normal daylight
2. harder lighting or shadows
3. moderate motion
4. at least one busy period
5. at least one entry/exit sequence

⠀
### Step 3.2

Create a **Replay Harness**.

It must:
1. ingest recorded clips deterministically
2. replay frame by frame
3. preserve timestamps or synthetic timing
4. save outputs from each module

⠀
### Step 3.3

Use CVAT to create a small gold evaluation subset.

Use:
1. automatic annotation only to accelerate
2. manual correction to ensure trust
3. track mode for moving objects when needed

⠀
CVAT supports automatic annotation and track mode specifically for these workflows.  

### Step 3.4

The initial gold subset must contain:
1. enough frames to verify detector quality
2. a few short clips to verify tracking and counting
3. at least one clip where the current dashboard logic can be visually compared with actual bay occupancy

⠀
### Supervisor gate for Phase 3

The phase passes only if:
1. clips can be replayed repeatedly
2. outputs are logged consistently
3. a small trusted reference set exists
4. the team can compare predictions to reality, not only to intuition

⠀
⸻

## Phase 4. Integrate the vehicle detector as an isolated module

### Step 4.1

Choose one baseline detector only.

Use:
1. **YOLO11s** as the first operational baseline

⠀
Reason:
1. it is fast enough for MVP use
2. accurate enough for a strong first pass
3. integrates easily with Ultralytics tracking/benchmark/export modes.  

⠀
### Step 4.2

Restrict detection scope to vehicles only.

Do not start with:
1. fine-grained vehicle taxonomy
2. pedestrians
3. bikes unless directly needed
4. unrelated classes

⠀
### Step 4.3

Wrap the detector inside a dedicated Detection Module.

Input:
1. normalized frame

⠀
Output:
1. canonical detection contract only

⠀
It must not:
1. know about bays
2. know about zones
3. update frontend directly
4. own counting logic

⠀
### Step 4.4

Evaluate the detector on the gold set using FiftyOne.

FiftyOne supports evaluate_detections() and inspection of best/worst samples, which is exactly the right workflow here.  

### Step 4.5

Record at least:
1. false positives
2. false negatives
3. latency
4. confidence distribution
5. failure conditions

⠀
### Supervisor gate for Phase 4

The phase passes only if:
1. detector output is serialized in the contract format
2. the detector is decoupled from UI/business logic
3. latency is observable
4. false positives and false negatives are inspected on the gold set
5. obvious missed vehicles are not ignored

⠀
⸻

## Phase 5. Integrate multi-object tracking

### Step 5.1

Add a dedicated Tracking Module after detection.

Use:
1. **ByteTrack** first

⠀
Reason:
1. it is a very strong practical first baseline for MOT
2. it is simpler than over-engineering appearance-heavy solutions
3. the Ultralytics tracking mode supports standard tracker integration including ByteTrack and BoT-SORT.  

⠀
### Step 5.2

The tracker must consume only:
1. detections
2. timestamps / frame IDs

⠀
The tracker must output only:
1. canonical track contract

⠀
### Step 5.3

Evaluate tracking quality on short clips.

Check:
1. track continuity
2. ID switches
3. track loss near entries
4. duplicate tracks for the same vehicle

⠀
### Step 5.4

Only if IDs are too unstable, test **BoT-SORT** as the second option.

Do not do this before measuring ByteTrack’s failure modes.

### Supervisor gate for Phase 5

The phase passes only if:
1. track IDs are stable enough for counting
2. one car is not repeatedly re-created as many tracks
3. the tracking module remains independent of zones and bays
4. the observed tracking errors are documented

⠀
⸻

## Phase 6. Build the spatial association layer on top of the existing bay system

This is where your current dashboard becomes operationally meaningful.

### Step 6.1

Create the **Association Module**.

Input:
1. tracked objects
2. active spatial config

⠀
Output:
1. bay membership
2. zone membership
3. line crossing signals

⠀
### Step 6.2

Use the existing bay polygons as the atomic spatial units.

This is important:
1. bay occupancy should remain the most granular physical truth in the current product
2. zones should be built above bays, not instead of bays

⠀
### Step 6.3

Add zone support.

Every bay must belong to a zone.
Zones are the objects that power feature 4 and later dashboard KPI cards.

### Step 6.4

Add line support for counting-enabled cameras.

Define:
1. entry line
2. exit line
3. optional direction semantics

⠀
### Step 6.5

Use Supervision primitives for the logic layer.

Why:
1. PolygonZone is suitable for polygon membership
2. LineZone is suitable for crossing counts and explicitly relies on tracking IDs.  

⠀
### Supervisor gate for Phase 6

The phase passes only if:
1. a tracked vehicle can be associated to a bay
2. a bay can be rolled up to a zone
3. a tracked vehicle can produce a line crossing event
4. association logic is separate from both detection and dashboard rendering

⠀
⸻

## Phase 7. Rebuild bay occupancy as a backend state engine

At this point the existing red/blue bay visualization must stop being a visual trick and become a real backend-driven state.

### Step 7.1

Create the **Bay Occupancy Engine**.

Input:
1. association outputs
2. bay polygons
3. track persistence over time

⠀
Output:
1. occupied/free state per bay
2. confidence
3. last changed time

⠀
### Step 7.2

Define the occupancy rule explicitly.

The developer must not improvise this.

Example rule structure:
1. occupancy starts when a tracked vehicle enters and remains in the bay area long enough
2. occupancy ends when the tracked vehicle leaves and remains absent long enough
3. brief flicker must not toggle the bay state

⠀
### Step 7.3

Add state smoothing / debouncing.

This is mandatory because raw frame-by-frame inference is noisy.

### Step 7.4

Drive the existing model-space bay colors from this backend state only.

### Supervisor gate for Phase 7

The phase passes only if:
1. a bay does not flicker because of one missed frame
2. the dashboard color is derived from the backend state store
3. bay state change timestamps are recorded
4. the developer can explain the exact occupancy rule in one paragraph

⠀
⸻

## Phase 8. Build zone occupancy and available-space estimation

This is feature 4 in its real form.

### Step 8.1

Create the **Zone Occupancy Engine**.

Input:
1. bay occupancy states
2. zone definitions

⠀
Output:
1. occupied bays per zone
2. available bays per zone
3. occupancy percentage per zone

⠀
### Step 8.2

Make zone KPIs aggregated from bays whenever bays exist.

That is the best design for your current product because:
1. bays already exist
2. it gives exact zone availability
3. it is more interpretable than loose object density

⠀
### Step 8.3

Only where no bays exist, allow fallback zone-level estimation from tracked vehicles in the zone polygon.

### Step 8.4

Store zone KPIs in the canonical state store.

### Supervisor gate for Phase 8

The phase passes only if:
1. zone totals equal the sum of their bays
2. available count never becomes negative
3. percentages are bounded correctly
4. the dashboard never computes these values by itself

⠀
⸻

## Phase 9. Build entry/exit counting

This is feature 5.

### Step 9.1

Create the **Flow Counting Engine**.

Input:
1. track outputs
2. line crossing signals
3. line metadata

⠀
Output:
1. entry events
2. exit events
3. cumulative counts
4. rate over time

⠀
### Step 9.2

The counting rule must be explicit.

A vehicle must be counted:
1. once per crossing
2. in the correct direction
3. only after a valid transition, not just because it touched a line boundary

⠀
### Step 9.3

Add anti-double-count safeguards.

The developer must explicitly prevent:
1. repeated counting when the vehicle hovers near the line
2. counting after tracker fragmentation
3. counting both directions for one noisy crossing

⠀
### Supervisor gate for Phase 9

The phase passes only if:
1. line crossings correspond visually to what the video shows
2. one vehicle is not counted multiple times for one pass
3. counting events are timestamped and stored
4. the dashboard reads counts from the state store, not from client-side logic

⠀
⸻

## Phase 10. Introduce the canonical state store and realtime delivery

This is the point where the system becomes a real application instead of a chain of scripts.

### Step 10.1

Create the **State Store**.

It must hold:
1. current bay states
2. current zone KPIs
3. current counts
4. current active alerts
5. timestamps of last updates

⠀
### Step 10.2

Create the **Realtime Delivery API**.

It must:
1. expose current state snapshots
2. expose incremental updates
3. decouple frontend rendering from backend internals

⠀
### Step 10.3

From this point onward:
1. the dashboard consumes only API/state outputs
2. no module may push arbitrary UI mutations directly

⠀
### Supervisor gate for Phase 10

The phase passes only if:
1. there is one canonical live state
2. different UI components show consistent values
3. all runtime state changes are reproducible from server outputs
4. the frontend is now a renderer, not the computation engine

⠀
⸻

## Phase 11. Extend the dashboard into a live operations dashboard

This is feature 6.

### Step 11.1

Keep the camera view and model-space view.

They already serve an important trust function.

### Step 11.2

Add top-level status cards for:
1. total occupied bays
2. total available bays
3. occupancy percentage overall
4. entries in recent interval
5. exits in recent interval
6. active alerts

⠀
### Step 11.3

Add zone-level cards or panels.

Each zone panel must show:
1. occupied
2. available
3. percentage
4. last updated

⠀
### Step 11.4

Make the dashboard clearly distinguish:
1. spatial editing mode
2. live monitoring mode

⠀
Never mix them again.

### Supervisor gate for Phase 11

The phase passes only if:
1. the dashboard is readable in seconds
2. all displayed numbers are backed by the state store
3. edit mode and live mode are separated
4. the existing bay visualization still works, now driven by real state

⠀
⸻

## Phase 12. Add the historical timeline store and short trends

This is feature 8.

### Step 12.1

Create the **Historical Timeline Store**.

At minimum store:
1. zone occupancy snapshots over time
2. entry rates over time
3. exit rates over time
4. alert activations over time

⠀
### Step 12.2

Choose short time windows only.

For this scope:
1. recent minutes
2. recent hour
3. maybe current day window

⠀
Do not overbuild analytics.

### Step 12.3

Add one compact timeline view to the dashboard.

Show:
1. occupancy trend
2. count trend
3. alert timeline if helpful

⠀
### Supervisor gate for Phase 12

The phase passes only if:
1. timeline values come from stored historical state
2. charts are simple and interpretable
3. the historical layer does not slow the live path excessively
4. the trend windows are actually useful

⠀
⸻

## Phase 13. Add threshold-based alerts

This is feature 7.

### Step 13.1

Create the **Alert Engine**.

It must read:
1. zone occupancy
2. available-space counts
3. entry rate
4. exit rate
5. system health metrics if desired

⠀
### Step 13.2

Start with only a few threshold rules.

For example:
1. zone occupancy above X%
2. available bays below Y
3. entry rate spike above threshold
4. stale pipeline / delayed updates

⠀
Grafana’s alerting model and Prometheus-style metric rules are appropriate references for how threshold-based alert rules are structured.  

### Step 13.3

Every alert must include:
1. source KPI
2. threshold
3. current value
4. severity
5. timestamp
6. active/inactive state
7. explanation text

⠀
### Step 13.4

Show alerts both:
1. inside the product dashboard
2. inside the operational observability dashboards

⠀
### Supervisor gate for Phase 13

The phase passes only if:
1. alerts are understandable
2. alerts do not fire constantly from noise
3. alerts can be tied back to the exact underlying KPI
4. the product is now actionable, not only descriptive

⠀
⸻

## Phase 14. Build ML quality evaluation, not just runtime health

This is where MLOps becomes real.

### Step 14.1

Use the gold set created earlier to measure:
1. detector quality
2. tracking/counting behavior on selected clips
3. bay occupancy correctness on selected sequences

⠀
### Step 14.2

Use FiftyOne for regular failure analysis.

It is specifically suitable for evaluating detections and inspecting good/bad samples.  

### Step 14.3

Define the reference distributions for drift monitoring.

At minimum monitor:
1. frame brightness distribution
2. object count per frame
3. vehicle bbox size distribution
4. detection confidence distribution
5. occupancy distribution by zone
6. count distribution by time bucket

⠀
### Step 14.4

Use Evidently to compare current production-like data against the reference window.

Evidently’s drift tools are designed for detecting distribution shift in features, predictions, and targets through presets and metrics.  

### Step 14.5

Be explicit about what drift means here.

There are three different things:
1. **input drift**
   * image/data characteristics changed
2. **prediction drift**
   * model outputs changed
3. **performance drift**
   * true quality degraded on annotated checks

⠀
The developer must not confuse them.

### Supervisor gate for Phase 14

The phase passes only if:
1. drift monitoring has a reference baseline
2. drift is measured on explicit features and predictions
3. quality checks are separated from system-health checks
4. the team can answer:
   * “Is the pipeline running?”
   * and also:
   * “Is the model still trustworthy?”

⠀
⸻

## Phase 15. Add deeper consistency and fault checks across the whole system

This phase is critical and often skipped.

### Step 15.1

Add state consistency assertions.

Examples:
1. occupied bays cannot exceed total bays in a zone
2. available bays cannot be negative
3. bay state cannot belong to an unknown zone
4. counts cannot decrease unless they are windowed counters
5. stale state must be flagged

⠀
### Step 15.2

Add temporal consistency checks.

Examples:
1. if ingestion continues but no detections arrive for too long, flag anomaly
2. if detections exist but no tracks exist, flag tracker failure
3. if tracks exist but no state updates occur, flag association/state failure
4. if dashboard data timestamp is too old, flag stale UI

⠀
### Step 15.3

Export these consistency failures as observability metrics and alerts.

This is where OpenTelemetry + Prometheus + Grafana become really valuable: the system must make its own internal contradictions observable.  

### Supervisor gate for Phase 15

The phase passes only if:
1. hidden failures become visible
2. stale data is detectable
3. inconsistent state is detectable
4. the system can report not just “up/down,” but “working correctly / partially degraded / inconsistent”

⠀
⸻

## Phase 16. Only now benchmark alternatives and optimize deployment

This comes late on purpose.

### Step 16.1

Benchmark only after correctness is established.

Use Ultralytics benchmark/export workflows to compare model/runtime combinations.  

### Step 16.2

Compare:
1. YOLO11s baseline
2. YOLO26s candidate
3. optional YOLO11m if quality is still insufficient

⠀
### Step 16.3

If hardware justifies it:
1. use TensorRT for NVIDIA acceleration
2. use OpenVINO if CPU / Intel deployment is important later

⠀
TensorRT is NVIDIA’s optimized inference SDK, and OpenVINO is designed to optimize and deploy inference across supported environments.  

### Supervisor gate for Phase 16

The phase passes only if:
1. optimization does not change correctness unexpectedly
2. benchmark decisions are evidence-based
3. the developer did not optimize before validating the logic

⠀
⸻

# 3\. The non-negotiable double-check routine the developer must follow at all times

For every single module, the developer must perform three checks.

## Check A. Module-local correctness

Ask:
1. does this module do exactly one job?
2. are inputs and outputs contract-compliant?
3. is the module testable in isolation?
4. are latency and errors observable?

⠀
## Check B. Upstream/downstream contract consistency

Ask:
1. does the output from the upstream module match what this module expects?
2. does this module preserve timestamps and IDs correctly?
3. is any business logic leaking into the wrong layer?

⠀
## Check C. End-to-end operational workability

Ask:
1. does this change improve the whole system?
2. can the dashboard still show coherent state?
3. can a human trust the new output?
4. do observability dashboards expose the new module properly?

⠀
If any one of these three checks fails, the developer must not move to the next phase.

⸻

# 4\. The most important architectural warnings

These are the mistakes that will destroy the project if the developer ignores them.

## Warning 1

Do not let the frontend remain the hidden source of truth.

## Warning 2

Do not compute occupancy, counts, or alerts in the UI.

## Warning 3

Do not let detector/tracker modules know about bays, zones, alerts, or dashboard state.

## Warning 4

Do not add optimization before correctness.

## Warning 5

Do not say “we have monitoring” if you only have server logs.
Real monitoring requires:
1. traces
2. metrics
3. health dashboards
4. alert rules
5. explicit inconsistency detection  

⠀
## Warning 6

Do not say “we detect drift” if there is no baseline/reference window and no measured distributions.
Drift monitoring requires reference-vs-current comparison. Evidently’s documentation is built around exactly this idea.  

⸻

# 5\. Final compressed build order

If I compress the entire plan into the strict order the one developer should follow, it is this:
	1. freeze scope and split editor vs live dashboard
	2. define all module contracts
	3. add observability scaffolding first
	4. persist and version spatial configs
	5. validate spatial configs
	6. collect replay clips
	7. create gold evaluation subset in CVAT
	8. integrate detector baseline
	9. evaluate detector with FiftyOne

⠀	10.	integrate tracker baseline
	11.	validate track stability
	12.	build association layer for bays / zones / lines
	13.	rebuild bay occupancy as backend state
	14.	build zone occupancy / available-space engine
	15.	build entry/exit counting
	16.	create canonical live state store
	17.	expose realtime API
	18.	extend dashboard with KPI cards
	19.	add historical timeline store
	20.	add short trends
	21.	add threshold alert engine
	22.	add ML quality and drift monitoring
	23.	add state consistency and stale-data checks
	24.	benchmark/optimize only after all above is correct

That is the professional order.  