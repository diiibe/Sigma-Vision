**Create a high-fidelity UI interfaceof a dark tactical parking monitoring dashboard, designed like a premium infrastructure intelligence control room. The interface should feel black-themed, technical, geometric, dense with information, and highly operational rather than consumer-oriented. Avoid a glossy sci-fi look; instead aim for a restrained, professional, mission-critical aesthetic.** 

Software implementation
**For the React + Three.js implementation:** build the central parking visualization as an interactive **React Three Fiber** scene embedded inside the dashboard. The parking structure must be a **moveable, rotatable, and zoomable 3D object** in space, controlled with smooth **orbit-style camera controls**. Use a fixed perspective camera aimed at the center of the parking cube, with user interactions enabled for **rotate, pan, and zoom**, while preserving a clean default isometric angle on initial load. The exploded parking structure should be implemented as a **transparent wireframe cuboid** containing **multiple stacked parking levels**, each rendered as a separate mesh group so levels can be individually highlighted, filtered, dimmed, or animated. Each parking level should contain a grid of slot meshes generated from structured data, with slot color driven by status: blue free, red occupied, green EV, yellow reserved. Lower levels should support reduced opacity to preserve readability. Add a subtle floor grid and thin vertical guide lines connecting levels so the exploded view still reads as one coherent building. Include smooth transitions for level separation, hover highlight, and slot selection. On hover, a slot should visually brighten or outline; on click, it should become selected and trigger the detail panel in the dashboard UI. The scene should support **mouse and trackpad interaction**, with constrained min/max zoom, slight damping, and bounded panning so the structure always remains legible. The cube should feel like a precise technical model, not a game object: use clean geometries, translucent materials, thin line segments, restrained glow, and no photorealistic textures. Structure the implementation into reusable components such as ParkingScene, ParkingCube, ParkingLevel, ParkingSlot, and SceneControls, with parking data driving geometry placement and status rendering. 
**The implementation must be designed as a hackathon-ready but future-adaptable system for an AI and computer-vision parking monitoring platform. At this stage, real CCTV streams and detection outputs are not yet available, so the UI and 3D visualization must be built around a clean, modular mock-data architecture that can later be replaced with live computer vision events, occupancy detections, vehicle metadata, camera states, and analytics feeds without requiring major refactoring. All visual elements, including parking slot states, occupancy metrics, event logs, camera panels, alerts, and selected-slot details, should be driven by structured mock data that simulates realistic parking-facility activity. The architecture must prioritize adaptability: separate presentation, scene rendering, and data layers; define clear interfaces for future CV/AI inputs; and ensure the dashboard can easily ingest real-time data from APIs, WebSockets, or inference pipelines once available. The current version should feel complete and believable for demo purposes, while clearly being engineered to evolve into a production-style monitoring interface as soon as live vision data becomes available.**

Design description:
The composition is a **wide dashboard layout** with **three main vertical zones** and a **top system bar**.

At the center, show the main visualization: a **3D exploded view of a multi-level parking structure** rendered in a clean isometric perspective. The parking structure is represented as a **transparent wireframe cuboid volume**, inside which **a configurable number of horizontal parking decks** are vertically separated and floating one above the other, like architectural layers pulled apart for inspection. The exploded separation between decks should be large enough to clearly read each level, but still preserve the idea that they belong to one compact stacked building. The full object should resemble a **rectangular parking cube opened into layered slices**.

Each deck contains a **regular grid of parking slots** laid out with strong geometric clarity. The parking slots are thin rectangular cells, aligned with a technical grid, with subtle outlines and status-based fills. The slot colors could be variable but should be used with clear operational meaning, an example is:

* **blue** for free slots

* **red** for occupied slots

* **green** for EV charging slots

* **yellow/amber** for reserved slots

These colored slots should appear mostly on the **top visible levels**, while the lower levels can be more subdued, dimmer, or partially transparent to preserve visual hierarchy. The topmost level should be the clearest and most readable. Some lower layers may show reduced opacity, line-only slot outlines, or sparse highlighted cells. The structure should feel analytical, not photorealistic: no realistic concrete textures, no decorative materials, just clean technical surfaces, wireframes, translucent planes, and precise lighting.

Around the parking cube, include a **faint volumetric wireframe bounding box** to make the whole object read as a coherent building envelope. Add thin connector lines or structural vertical guide lines between levels so the exploded layers still read as one system. Beneath the parking structure, include a subtle **technical ground grid** to reinforce depth and spatial orientation.

The central scene should use a **dark near-black background**, with only a slight cool tint if needed. The background must include a **very subtle cross-grid or micro-grid pattern**, like faint technical drafting marks or tiny plus-shaped registration marks. The pattern should be barely visible, just enough to create a tactical interface feel. The overall palette should lean toward:

* matte black

* charcoal

* graphite

* dark gunmetal

* smoked glass transparency

The UI panels surrounding the main scene should feel like **semi-transparent dark glass tactical overlays**, with:

* very thin borders

* low-opacity fills

* squared corners or very slightly rounded corners

* layered transparency

* restrained inner glow

* subtle edge highlights

* no heavy shadows

* no bright neon bloom

The **top bar** should span the full width of the layout and read like a system control header. It should contain:

* the dashboard or facility title on the left

* a timestamp or real-time clock near the center

* a system status indicator on the right, such as “SYSTEM ONLINE”

* optional connection/health indicators

* all text should be aligned, compact, and highly legible

The **left side panel** should be a vertical control panel dedicated to parking analytics and filtering. It should contain multiple configurable stacked modules such as:

* a parking levels list

* occupancy summary

* key KPIs

* filters by slot state

* maybe a small sensor or category module

The information architecture should feel precise and hierarchical. Show items such as:

* total occupancy

* occupied vs available

* EV slot count

* occupancy percentage

* level-by-level breakdown

* filters for free, occupied, EV, reserved

These modules should use clean dividers, compact typography, horizontal progress lines or bars, and small technical labels. The styling should resemble monitoring software rather than a business dashboard template.

The **right side panel** should contain monitoring feeds and logs. At the top, show a vertical list of **CCTV camera feed cards**, each one containing:

* a small image thumbnail

* camera identifier

* timestamp or status tag

* subtle frame/border treatment

Below that, show an **event log** module with compact rows for recent system events such as:

* vehicle entered slot

* slot occupied

* EV charging active

* reserved bay detected

* sensor update

The log should look machine-generated and operational, with timestamps and concise entries.

Overlay near the bottom center of the main visualization a **slot detail card** for a selected parking space. This card should be semi-transparent dark glass like the rest of the interface and should contain detailed structured information for one selected slot, for example:

* slot ID

* status

* license plate

* sensor status

* associated camera

* last detection time

* action buttons such as reserve, view camera, mark available

This card should visually connect to the selected slot in the 3D view, either by placement, highlight, or a subtle leader line.

The overall typography should be **technical, modern, compact, and highly legible**. Use a style similar to:

* condensed sans-serif for headings

* clean UI sans-serif for labels

* mono or semi-mono style for numbers, timestamps, and identifiers

Text should be mostly off-white, muted gray, and light silver, with functional color accents only where semantically needed. Avoid oversized text. The interface should feel dense but organized.

The lighting should be restrained and cinematic in a practical way:

* low ambient light

* subtle reflections on glass panels

* gentle emphasis on the central parking cube

* slight glow on active lines or selected elements

* no dramatic neon lighting


The result should look like a **concept render for a real high-end parking operations platform**, somewhere between:

* infrastructure command center

* security monitoring interface

* smart mobility control room

* tactical operations software

It should communicate:

**precision, control, spatial awareness, occupancy intelligence, CCTV integration, layered structure analysis, and real-time operational monitoring.** 

## **Negative prompt**

**Avoid:** unrealistic sci-fi interfaces, rounded consumer-app cards, photorealistic concrete parking garage textures, cartoonish icons, oversized typography, cluttered layout, glowing gradients, excessive lens flare, futuristic fantasy cockpit elements, bright white background, colorful decorative charts, soft playful design language, messy perspective, unrealistic slot proportions.

## 
