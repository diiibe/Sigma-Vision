# SIGMA VISION — Technical Report

**Turn hours of parking footage into actionable moments — recognize events, save time.**

Beantech Spring Hackathon 2026 — Challenge 2: From Video to Value
Team: Lorenzo Di Bernardo, Giovanni Mason, Lorenzo Gobbo

---

## 1. Executive Summary

Sigma Vision is an end-to-end AI-powered parking operations platform that processes raw surveillance video and transforms it into structured, actionable intelligence. The system ingests multi-camera parking footage, runs real-time vehicle detection and tracking, computes occupancy and traffic metrics, detects behavioral security events, and presents everything through an interactive dashboard with a 3D interactive digital twin.

The platform delivers all four required metrics (vehicle count, real-time occupancy, average dwell time, and entry/exit counts) and expands into bonus areas: behavioral event detection (running, chasing, fighthing, crowd gathering, dwelling), a spatial configuration editor, live video analysis with specific evidence-back clip creation, GDPR-conscious event-driven storage, and edge-ready architecture.

It is a working full-stack application with a FastAPI backend, a React/Three.js frontend, and SQLite storage. It processes video in real time and will be shown live during the demo.

---

## 2. Problem Context

Parking facilities generate thousands of hours of surveillance footage monthly but almost none is analyzed. 
As we discovered through an initial process of Customer Discovery (a methodology coming from the business field to uncover what prospects need and indentify a likeable product-market fit), we conducted interviews with parking operators, and we found out that they face three recurring problems:

**Hours watching recordings.** Investigating one incident, one dispute, one small accident, or one security issue can mean hours of video review. Sometimes, one case takes a full day of work of an one employee.

**ERP blind spots.** Traditional parking ERPs (main company softwre) handle billing and access control but cannot detect human behaviors, traffic flow issues and queue formation. IFor example, when queues form at the exit, ERPs cannot automatically recognize who should receive extra grace time for payment, charging them additional fares. These blind spots cause heavy customer dissatisfaction and Costumer Lifetime Value (CLV) impact, revenue leakage, and safety gaps.

**High data retention, low information density.** Facilities store weeks of continuous video for compliance. Most footage contains nothing operationally relevant. Under GDPR, storing more data than necessary increases both compliance risk and infrastructure cost.

Sigma Vision addresses all three: it watches the video so operators don't have to, flags behaviorally significant moments, and lets the operator download precisely the clip they need. What previously required hours of manual review can be reduced to a few minutes

---

## 3. Challenge Alignment

### Required Metrics — All Implemented

| Required Metric | How It Works |
|---|---|
| **Vehicle count** | YOLOv8s-VisDrone detection per frame, tracked with Hungarian matching. Per-zone and facility-wide counts in real time. |
| **Real-time occupancy** | Per-bay binary classification via ResNet50 RCNN with ROI pooling, stabilized through a hysteresis FSM (N-frame confirmation). Zone and facility rollups each cycle. |
| **Average dwell time** | Derived from occupancy state transitions: timestamps logged at OCCUPIED→FREE. Duration = difference between transitions. |
| **Entry/exit counts** | User-defined counting lines with directional crossing detection via centroid trail analysis (8-frame history). Events logged with track ID, timestamp, confidence. |

### Bonus Areas Addressed

| Bonus Area | Coverage |
|---|---|
| **Advanced analytics** | Density zone monitoring with evolving insights |
| **Evolved insights** | Occupancy heatmaps overlays, congestion detection, threshold-based alerting (capacity, flow rate, net flow) |
| **Multi-camera** | Per-camera projections from global config, independent threads, facility-wide aggregation. Cross-camera identity will be future work. |
| **Edge AI** | CPU-only inference, ONNX-exportable models, bounded memory, no external DB server. 
| **Privacy-by-design** | Event-driven storage, no facial recognition, no individual identification, retention limits, data minimization |

---

## 4. System Architecture

### End-to-End Pipeline

```
Raw MP4 (one per camera)
  → Frame extraction at 5 FPS (ffmpeg)
  → YOLO detection (vehicles or persons)
  → centroid + IoU)-matching tracker
  → Spatial logic:
      - Bay occupancy: RCNN + hysteresis FSM
      - Line crossing: centroid trail analysis
      - Density: polygon containment + smoothing
      - Behavioral events: FSM + proximity + speed
  → Metric aggregation (zone rollups, hourly/daily)
  → Evidence generation (clips, annotated frames)
  → SQLite persistence + REST/SSE API
  → React dashboard (3D twin, live feeds, analytics)
```

### Three Functional Modules

1. **Live Occupancy Dashboard** (`/live`) — Bay-level occupancy with 3D digital twin, camera feeds with polygon overlays, zone KPIs, alerts, event archive.
2. **Vehicle Analysis & Counting** (`/analysis`, `/counting`) — User-defined counting lines and density zones, live YOLO bounding boxes, entry/exit session tracking, hourly timelines.
3. **Security Event Detection** (`/events`) — Behavioral monitoring: running, chasing, fighting , crowd gathering, zone entry, dwelling. Live feed with event badges and clip download.

All modules share spatial configuration and camera infrastructure but run independent processing pipelines with dedicated models, and state.

### Key Architectural Components

**Video Ingestion.** `VideoIngestionManager` discovers MP4 files, extracts frames at normalized 5 FPS via ffmpeg, caches as JPEGs. Loop detection resets tracker state at video boundaries. 5 FPS is deliberate: parking is a slow-changing environment, and lower framerate enables real-time CPU processing.

**Vehicle Detection.** YOLOv8s fine-tuned on VisDrone. Outputs normalized bounding boxes with class and confidence. 

**Person Detection (Security).** YOLO11s with COCO weights, filtered to person class only. COCO works for upright people even from overhead angles.

**Tracking.** Custom Hungarian matching (`ByteTrackAdapter`). Cost = weighted centroid distance + IoU. Track buffer: 30 frames. No re-ID CNN needed for low-density parking scenes.

**Occupancy Classification.** ResNet50 RCNN with TorchScript ROI pooling (128×128). Binary classification per bay (occupied/free). Hysteresis FSM requires N consecutive confirmations before toggling state — eliminates flicker from shadows and partial occlusions.

**Line Crossing Engine.** 8-frame centroid trail per track. Segment intersection test against counting lines. Filters: min track age (3 frames), trail sanity check (genuine traversal, not jitter), cooldown (5 frames per track/line). Zero DB writes during counting — events accumulated in memory, flushed on session stop.

**Density Engine.** Ray-casting point-in-polygon. Track age filter (≥2 frames). 3-frame moving average smoothing. Capacity threshold comparison for alerts.

**Behavioral Event Engine.** FSM-based detection of six behaviors:

| Behavior | Logic | Thresholds |
|---|---|---|
| Running | Speed > threshold for N frames | speed > 0.012, 3 frames |
| Chasing | Two tracks close + both fast | proximity < 0.15, speed > 0.004 |
| Fighting | Multiple tracks very close + moving | proximity < 0.08 |
| Zone entry | Centroid outside→inside polygon | Ray-casting |
| Dwelling | Track in zone > time threshold | 10 seconds |
| Crowd gathering | 3+ persons in zone | Count ≥ 3 |

Design rationale: composing behaviors from primitives (rather than end-to-end video classification) provides explainability, per-zone configurability, and evidence-linked clip extraction.

**Multi-Camera.** Global spatial config projected per camera. Each camera runs independent threads. Dashboard aggregates for facility-wide metrics. No cross-camera identity association yet.

### Threading Model (GIL-Safe)

| Thread | Role | I/O |
|---|---|---|
| HTTP (FastAPI) | Serves REST, reads cached state | No heavy compute |
| Scheduler | Frame advance, occupancy pipeline, snapshot persistence | Skipped when counting/security active |
| Counting (per session) | YOLO + tracker + line crossing at native FPS | Zero DB writes during ticks |
| Security (per camera) | YOLO person + tracker + behavioral engine | Own SQLite DB |

No explicit locks on the counting hot path — Python's GIL guarantees atomic dict assignment. This allows the counting loop to sustain 10–22 FPS on CPU.

---

## 5. Technical Choices and Rationale

### Model Selection

| Model | Params | mAP@0.5 | Selection |
|---|---|---|---|
| YOLOv8n-VisDrone | 3.2M | 0.341 | Too low accuracy |
| **YOLOv8s-VisDrone** | **11.2M** | **0.408** | **Best accuracy/speed for real-time CPU** |
| YOLOv8m-VisDrone | 25.9M | 0.454 | Marginal gain, 2× slower |
| YOLOv8x-VisDrone | 68.2M | 0.470 | Best accuracy, 4× slower |

We trained a YOLO11s variant on VisDrone (5 epochs, batch 4, 640×640, Apple Silicon MPS) to evaluate the newer architecture. Weights preserved in repository.

**Why not a heavier model?** Live analysis at 5 FPS on CPU requires ≤200ms/frame budget. YOLOv8s runs at ~48ms/frame, leaving headroom for tracking and logic. Lower per-frame confidence is compensated by hysteresis: a single false negative doesn't cause a state change — only sustained disagreement does.

**Why not COCO?** We tested YOLO11s-COCO on parking footage: near-zero valid detections. Cars misclassified as "train," "cell phone," "suitcase." The domain shift from street-level to overhead is fundamental, not tunable. Documented in `notebooks/yolo_coco_baseline.ipynb`.

**Why Hungarian over DeepSORT?** Parking lots have low object density and predictable motion. IoU + centroid cost provides sufficient discrimination without re-ID CNN overhead. O(n³) assignment is manageable for 5–30 tracks/camera.

**Backend stack.** FastAPI for async + Pydantic validation. SQLite WAL mode for ACID persistence without a DB server. File-based JSON config versioning for inspectability and portability.

**Frontend stack.** React 19 + TypeScript, Three.js (@react-three/fiber) for the 3D digital twin, Zustand for state, Vite for fast builds. The 3D visualization provides spatial context that tables cannot — operators see congestion patterns at a glance.

---

## 6. Datasets

### Primary: VisDrone 2019

| Property | Value |
|---|---|
| Images | ~8,629 (6,471 train / 548 val / 1,610 test) |
| Perspective | Aerial / drone (overhead, angled) |
| Vehicle classes | car, van, truck, bus, motor |
| Format | YOLO bounding boxes |

**Why VisDrone.** Parking cameras are mounted high and angled down — closer to drone footage than street-level COCO images. VisDrone is the largest public dataset with this perspective and fine-grained vehicle annotations.

**Caveats.** Drone viewpoints vary more than fixed cameras. Scenes are from Chinese cities (vehicle distributions differ from European contexts). No nighttime footage.

### Primary: CHAD (UNC Charlotte)

CHAD is one of the datasets explicitly recommended in the challenge and contains multi-camera footage with human activities and anomalous behaviors. :contentReference[oaicite:0]{index=0}  

We used CHAD as a primary reference for **behavior understanding, testing, and modeling**. It was fundamental to design and calibrate our behavioral policies (running, fighting, crowd gathering, dwelling) using FSM logic, thresholds, and temporal consistency.

In the GitHub repository, CHAD is not explicitly included as a full dataset due to size constraints. Only a limited number of extracted clips are present. However, when running the project through the Docker setup, the full set of videos used during development can be accessed and integrated into the pipeline.

### Supplementary

- **PKLot** and **CNRPark+EXT**: Parking occupancy datasets (binary occupied/free) from fixed overhead cameras. Used for ResNet50 RCNN training.
- **Demo videos**: MP4 recordings from parking facilities, looped to simulate live feeds.

The pipeline is dataset-agnostic: any MP4 in the video directory is discovered and processed. Challenge-recommended datasets such as DLP and CHAD can be integrated with minimal setup (file placement + spatial configuration).

---

## 7. Dashboard and Demo

### Live Dashboard (`/live`)

Three-panel tactical layout:
- **Left — Analytics:** Occupancy rate, slot breakdown (occupied/free/EV/reserved/unknown) with toggle filters, zone/level filters, CSV export.
- **Center — 3D Digital Twin:** Multi-level parking as stacked layers, color-coded bays (blue=free, orange=occupied, green=EV, yellow=reserved). Click any bay for detail card (status, confidence, dwell, actions). Orbit controls. Occupancy dwell and turnover heatmap overlays.
- **Right — Monitoring:** Live camera feed with SVG bay overlays, camera switching, event log with severity badges, paginated event archive.

### Vehicle Analysis (`/analysis`)

Draw counting lines and density zones directly on camera image. Live YOLO bounding boxes (yellow default, green on entry crossing, red on exit). Up to 2 simultaneous tasks with zero-cost canvas cloning. Session log with entry/exit tallies.

### Event Detection (`/events`)

Define security zones, enable behavior types. Live feed with person bounding boxes and color-coded event badges (red=running, orange=chasing, pink=fighting). Per-task counters. 5-second evidence clip download.

### Demo Flow

1. `/live` — 3D twin updating live, click bay, show detail, switch cameras, filter.
2. `/analysis` — Draw counting line, toggle on, watch vehicles cross, counter increments.
3. `/events` — Security task with zone, event badges flash, download clip.
4. `/live` — Facility metrics, event archive, CSV export.

Everything runs live on one machine. No pre-recorded results.

---

## 8. Baseline Comparison

**Baseline A — COCO YOLO (no domain adaptation):** Near-zero valid detections on parking footage. Cars classified as "train," "TV," "cell phone." Documented in notebook. Demonstrates that domain adaptation is necessary, not optional.

**Baseline B — Naive counter (no tracking, no temporal logic):** Would suffer from state flicker, double-counting, no behavioral analysis, no evidence trail.

| Capability | COCO Baseline | Naive Counter | Sigma Vision |
|---|---|---|---|
| Overhead detection | Fails | Needs VisDrone | mAP@0.5 = 0.408 |
| Stable occupancy | N/A | Flickers | Hysteresis FSM |
| Entry/exit counting | N/A | Double-counts | Trail-validated + cooldown |
| Behavioral events | N/A | N/A | 6 event types via FSM |
| Evidence clips | N/A | N/A | 5s ffmpeg extraction |
| Dashboard | N/A | N/A | 3D twin + live feeds |

We do not fabricate quantitative accuracy metrics. We lack ground-truth annotations for our demo footage, so we cannot report precision/recall. The demo itself is the evidence: judges can verify that vehicles are detected, crossings are counted, behaviors are flagged by watching the system operate live, clips for filtered events are created immediately for operators, saving hours of manual review.

---

## 9. Real-World Impact

**Time saving.**  
Daily operations often require manual video checks that can take hours. With Sigma Vision, operators can access the exact moment of interest in seconds through the event log, reducing investigation time and freeing staff for higher-value tasks.

**Proactive intervention.**  
The system detects critical situations such as fighting, crowd gathering, and unauthorized zone access in real time. This enables faster intervention and improves on-site safety and control.

**ERP blind spots**  
Sigma Vision highlights operational blind spots that traditional ERPs cannot see, such as exit congestion, incorrect grace time handling, and abnormal vehicle behavior. This helps prevent revenue missing and ensures fair billing.

**Storage and compliance.**  
Only relevant video clips are stored instead of continuous recordings. This reduces storage costs and aligns with GDPR data minimization (Article 5(1)(c)), lowering compliance risk.

**Service quality and business impact (CLV, CAC)**  
Faster issue resolution, fewer disputes, and safer environments improve the user experience. This leads to higher retention, lower CAC, and higher CLV, directly impacting long-term profitability.

---

## 10. Scalability and Deployment

**Additional cameras:**  
New cameras can be added by connecting an MP4 or RTSP stream and defining the spatial configuration in the UI. Each camera runs in an independent thread, enabling horizontal scaling. Expanding to new areas or floors requires only configuration, not architectural changes.

**Compute:**  
With a CPU bottleneck of ~48 ms per frame, the system runs in real time at reduced FPS. A single GPU can support ~4–8 camera streams at full frame rate. Using ONNX export and NVIDIA TensorRT, we estimate a 3–5× speedup. A frame filtering strategy ensures controlled performance degradation under load, maintaining system stability.

**Edge-ready:**  
The system runs without external infrastructure using SQLite and lightweight models compatible with edge devices (e.g., NVIDIA Jetson). Event-driven storage reduces bandwidth by keeping only relevant clips instead of continuous video.

**Productionization path:**  
Next steps include RTSP ingestion, GPU inference, authentication (RBAC), message queues for resilience, PostgreSQL for scale.

---

## 11. Privacy and Compliance

- **No individual identification.** Detects object classes (vehicle types, person) as anonymous numbered entities. No facial recognition, no license plate reading, no biometrics.
- **Person detection scoped to behavior.** Bounding boxes with track IDs only. No appearance features extracted or stored.
- **Event-driven storage.** Only clips around flagged events retained, not continuous video. Configurable retention limits per table (auto-pruning).
- **Transparency.** All processing local and auditable. Every flagged event traceable to specific tracks, thresholds, and confidence scores.
- **Future:** Face blurring, license plate masking, RBAC, audit logging. Not yet implemented.

---

## 12. Main Technical Choice: Model Size vs Speed with constraint: System Reliability

**Model size vs. speed trade-off.**  
A key technical choice in Sigma Vision was to prioritize a smaller, faster model over a larger and more accurate one. This decision was driven by the requirement to enable real-time processing, on CPU, and being edge-compatible, which is essential for practical deployment in parking facilities.

While larger models can achieve higher standalone accuracy, they introduce latency that would prevent live analysis. By selecting a lightweight model, we ensure that the system can process frames continuously and support multiple camera streams with limited resources.

**Confidence threshold and error strategy.**  
To mitigate the lower raw accuracy, we deliberately lowered the detection confidence threshold. This reduces false negatives (missed vehicles or persons), which are more critical than false positives in our context. Missing an event means losing it completely, while a false positive can be filtered later.

The system is designed around a clear objective: **time + evidence** than mean business value and product-market fit.
We aim to reduce manual video inspection and return only relevant moments, each supported by a short clip and contextual metadata.

**System-level reliability over model accuracy.**  
This design makes a controlled number of false positives acceptable. The system compensates through multiple stabilization layers: multi-object tracking to maintain identity over time and hysteresis to prevent flickering decisions, and finite state machines (FSM) to validate event persistence and logic.

These mechanisms transform noisy frame-level detections into stable, high-confidence events. As a result, the overall system reliability is significantly higher than the raw detector performance.

**Evaluation limitations and practical validation.**  
Given the absence of fully annotated parking footage, we cannot yet provide precise quantitative evaluation on the target domain. However, the system is designed to extract meaningful events with interpretable confidence, allowing users to efficiently search, review, and validate them instead of analyzing raw video streams.

In this context, the trade-off is intentional: slightly more false positives in exchange for fewer missed events and a system that is usable in real time.
Operators still gain time and efficiency, while the system remains live, reliable and cost-effective. Win - Win.

---

## 13. Limitations

**Model.**  
The YOLOv8s-VisDrone model was trained on aerial drone footage, which only partially matches the visual characteristics of fixed parking cameras. While both share an overhead perspective, real deployments introduce different camera heights, angles, lens distortions, and environmental conditions. This creates a generalization gap that can affect detection reliability, especially in edge cases. On the behavioral side, our approach relies on rule-based logic (speed, proximity, persistence), which is interpretable and lightweight but partially limited: it cannot distinguish visually similar but semantically different interactions (e.g., a friendly interaction vs. a real aggression). 
Addressing this would require richer fine-tuned temporal models or pose-based reasoning, which were outside the scope of this project.

**Perspective distortion.**  
The system works directly on the image, assuming that all parts of the scene have the same scale. In reality, this is not true: objects closer to the camera look bigger and appear to move faster, while objects farther away look smaller and slower.
This affects parts of the system such as: speed estimation, distance between objects, and zone-based logic.
A more accurate approach will map the image to a real-world ground plane using camera calibration. This was not implemented due to time constraints.

**No cross-camera identity.**  
Each camera is processed separately, and the system cannot recognize the same vehicle or person across different cameras. This makes the system simpler and more stable, but creates some limitations.
We cannot track a vehicle as it moves from one camera to another. This also limits more advanced analysis, such as full path tracking or movement across zones.
To solve this, we would need cross-camera re-identification, which requires more complex models and better camera alignment. This was not implemented due to time and a relevant data constraints.

**No ground-truth evaluation on target domain.**  
While we report quantitative metrics from the VisDrone dataset, we do not had annotated ground-truth data. This means that we cannot rigorously measure precision, recall, or end-to-end system accuracy in the target domain. Instead, validation relies on qualitative observation during the demo. 
The ability to benchmark performance, compare models, or systematically optimise system parametrization is, therefore, limited. A proper evaluation pipeline would require collecting and annotating parking data, which is a clear next step for future development, allowed by the integration of ERPs in production.

**Hackathon constraints.**  
As a hackathon project developed under strict time and resource constraints, several components were intentionally simplified. The system is currently deployed on a single machine without distributed processing. These decisions allowed us to prioritize a working end-to-end pipeline and a live demo. Addressing these limitations requirer additional engineering time, data collection, and infrastructure design.

---

## 14. Future Work

**Short-term:**  
Ground-truth annotation for quantitative evaluation. Extended YOLO11s training. Perspective stabilization for consistent spatial measurements.  
--> Focus: transforming the current prototype into a measurable, production-ready perception pipeline.

**Medium-term:**  
Cross-camera re-identification via appearance embeddings. Traffic flow mapping (vehicle transitions through zone sequences). ERP integration feedback loop. Pose estimation for behavioral disambiguation.  
--> Focus: turning perception into operational intelligence that integrates directly with existing parking management systems.

**Long-term:**  
Edge deployment with TensorRT. Federated learning across facilities. Predictive occupancy forecasting. Automated alerting integrations (Slack, SMS, building management).  
--> Focus: building a scalable, NVIDIA-accelerated platform that transforms parking infrastructure into a real-time decision-making system.

---

## 15. Reproducibility

### Quick Start — Docker (recommended)

```bash
git clone https://github.com/diiibe/Sigma-Vision.git && cd Sigma-Vision
docker compose up demo
# Open http://localhost:5173
```

The Docker image includes pre-baked demo state: videos, model weights, spatial configurations, and sample events.

### Quick Start — Local Development

```bash
git clone https://github.com/diiibe/Sigma-Vision.git && cd Sigma-Vision
npm install
python3 -m venv .venv && source .venv/bin/activate
pip install -r backend/requirements.txt
# Place .mp4 files in demo/videos/
# Place yolov8s_visdrone.pt in backend/model/
#   (from HuggingFace: mshamrai/yolov8s-visdrone)
npm run dev:demo
# Frontend: http://localhost:5173 — Backend: http://localhost:8000
```

### Key Dependencies

**Backend:** FastAPI ≥0.116, PyTorch ≥2.10, Ultralytics ≥8.3, Shapely ≥2.0, NumPy ≥2.2
**Frontend:** React 19, Three.js 0.179, @react-three/fiber, Zustand 5, TypeScript 5.8, Vite 7

### Repository Structure

```
Sigma-Vision/
├── backend/           # FastAPI backend (50+ endpoints)
│   ├── vision/        # YOLOv8s detector + Hungarian tracker
│   ├── runtime/       # Pipeline, counting engine, storage, config
│   ├── eventdetect/   # Security behavioral detection module
│   └── model/         # Weights + RCNN architecture + training artifacts
├── src/               # React/TypeScript frontend (~18K LOC)
│   ├── dashboard/     # Live tactical dashboard
│   ├── counting/      # Vehicle analysis + traffic counting
│   ├── eventdetect/   # Security event detection UI
│   ├── editor/        # Spatial configuration editor
│   └── scene/         # 3D Three.js parking visualization
├── notebooks/         # Model comparison, COCO baseline, training analysis
├── datasets/          # VisDrone, PKLot, CNRPark, CHAD
├── docker/            # Multi-stage Dockerfile, nginx, entrypoint
├── demo/              # Demo videos + lot definitions
├── docs/              # Architecture docs, training notebooks
└── contracts/         # Shared JSON Schema definitions
```

---

## 16. Conclusion

Sigma Vision managed to extract meaningful parking intelligence from standard surveillance footage through a set of carefully selected and well-integrated components, without requiring expensive hardware, proprietary datasets, or external cloud APIs.

From a technical point of view, the strength of Sigma Vision is in how the components work together. Detection, tracking, and rule-based logic are combined into a single pipeline that runs in real time and produces stable, usable outputs. The focus is not only on model accuracy, but on building a system that works continuously, is explainable, and can run under real constraints.

Under an operational perspective, the value is clear. Parking operators spend hours reviewing footage, miss important events, and rely on systems that cannot see what actually happens in the parking. Sigma Vision changes this: it flags only relevant moments, provides immediate evidence, and allows operators to focus only on what matters.

The central idea behind our design is simple: **time + evidence**.  
We do not just detect objects. We reduce the time operators spend searching through video, and we return interpretable events with contextual clips that can be reviewed immediately. In this sense, the value of the system is not only in perception accuracy, but in its ability to transform raw footage into searchable, operationally useful moments.

We stated our limitations clearly. The detector is not yet fine-tuned on the final target domain, behavioral understanding is still limited without richer temporal models or pose estimation, and cross-camera identity is not yet implemented. 

Overall, Sigma Vision managed to provide a strong and realistic foundation: the architecture is modular, the pipeline is reproducible, the demo is live, and the path toward production is concrete. 
The prototype already shows how parking video can move from passive storage to operational intelligence.

Sigma Vision is not about seeing more: it is about understanding what matters, when it matters.

### ***DETECTING WHAT YOU NEED.***

### ***SIGMA VISION***

---

## The Sigma Team

**Lorenzo Di Bernardo**  
- Role: ML, Computer Vision, Software Development  
- University: University of Trieste  
- Current study: Data Science and Artificial Intelligence — Foundational curriculum  

**Giovanni Mason**  
- Role: ML, Pipeline Design, Business Development  
- University: University of Trieste  
- Current study: Data Science and Artificial Intelligence — for Industry and Digital Twin  

**Lorenzo Gobbo**  
- Role: ML, Solution Design, Data Management  
- University: University of Trieste  
- Current study: Mathematics — Computational Mathematics and Modelling  

Our team combines different yet complementary backgrounds, such as computer vision, data science, mathematics, and business.
This multidisciplinary approach helped us not only build the technical pipeline, but also design a solution that is usable in real-world parking operations.
