# Spatial Config — Architettura e Data Model

Documento autoritativo che descrive la struttura dati, le relazioni tra entità, il flusso di salvataggio, il supporto multi-camera e il flusso di predizione del sistema di configurazione spaziale.

> **Stato**: descrive il **target** dell'implementazione corrente. Dove il codice attuale diverge, è indicato come **BUG** o **TODO**.

---

## 1. Entità Principali

### 1.1 Bay (`SpatialBayDefinition`)

Una **bay** è un'entità astratta che rappresenta un posto auto nella matrice 3D. Non è legata a nessuna camera specifica — è una posizione logica nella struttura del parcheggio.

| Campo | Tipo | Descrizione |
|-------|------|-------------|
| `id` | `string` | Identificatore univoco (es. `B01`) |
| `label` | `string` | Etichetta leggibile |
| `row` | `int` | Riga nella griglia del partition |
| `column` | `int` | Colonna nella griglia del partition |
| `levelId` | `string` | Livello nella matrice 3D |
| `partitionId` | `string` | Partizione (sottogruppo del livello) |
| `zoneId` | `string` | Zona logica di appartenenza |
| `layoutPolygon` | `PolygonPoint[]` | Poligono nella vista layout 2D (camera-indipendente) |
| `evCapable` | `bool` | Supporto ricarica EV |
| `reservedDefault` | `bool?` | Riservato di default |

**Campi legacy da rimuovere** (attualmente presenti, **BUG/TODO**):
- `imagePolygon` — duplica i dati di `CameraObservationPolygon.imagePolygon`
- `cameraId` — duplica la relazione in `CameraObservationPolygon.cameraId`
- `sourceCameraIds` — derivabile dalle observation polygons associate

> **Regola**: una bay esiste nella matrice 3D **solo se** ha almeno una `CameraObservationPolygon` associata. Se il poligono viene eliminato, la bay viene **rimossa** dalla matrice (l'entrata nella griglia diventa vuota). La bay non "sopravvive" senza poligono — il poligono è ciò che dà esistenza operativa alla bay.

### 1.2 Observation Polygon (`CameraObservationPolygon`)

Una **observation** è il collegamento tra una bay astratta e una specifica camera. Definisce il poligono nell'immagine della camera che corrisponde a quella bay.

| Campo | Tipo | Descrizione |
|-------|------|-------------|
| `id` | `string` | ID univoco (es. `obs-PTL3-B01`) |
| `cameraId` | `string` | Camera che osserva questa bay |
| `presetVersion` | `int` | Versione del preset in cui è stato creato |
| `canonicalBayId` | `string` | ID della bay associata (`→ SpatialBayDefinition.id`) |
| `imagePolygon` | `PolygonPoint[]` | Poligono nell'immagine della camera (coordinate normalizzate 0-1) |
| `enabled` | `bool` | Se attiva per le predizioni |
| `priority` | `int?` | Priorità (per multi-camera, più alto = preferito) |
| `notes` | `string?` | Note dell'utente |

**Relazione**: `Bay 1 ← N Observation` — una bay può avere poligoni su multiple camere.

### 1.3 SpatialConfig (Contenitore Globale)

La configurazione spaziale è un **singolo documento globale** (non per-camera) che contiene tutte le entità:

```
SpatialConfig
├── bays[]                    — tutte le bay di tutte le camere
├── observationPolygons[]     — tutti i poligoni di tutte le camere
├── zones[]                   — zone logiche
├── lines[]                   — linee di conteggio (per camera)
├── levels[]                  — livelli della matrice 3D
├── partitions[]              — partizioni (sottogruppi dei livelli)
├── cameras[]                 — definizioni delle camere
├── frames[]                  — frame di riferimento (per camera)
└── metadata                  — facilityId, version, status, timestamps...
```

### 1.4 Versioning

Le configurazioni sono versionate. Ogni versione è un file JSON completo e autonomo:

```
backend/state/{env}/canonical/spatial-configs/
├── manifest.json              — { activeVersion: 5, versions: [...] }
└── versions/
    ├── 000001.json
    ├── 000002.json
    └── 000005.json            — versione attiva
```

**Stati**: `draft` → `active` → `archived`

Solo una versione può essere `active` alla volta. Attivare una versione archivia automaticamente la precedente.

> **Rollback**: le versioni archiviate **non vengono eliminate**. L'utente può in qualsiasi momento riattivare una versione precedente, ripristinando la configurazione completa (bay, poligoni, zone, linee) com'era al momento della sua creazione. Questo garantisce che eliminare poligoni nella versione corrente non sia un'operazione irreversibile — basta tornare a una versione precedente che li conteneva.

---

## 2. Matrice 3D

La matrice 3D è la rappresentazione visuale del parcheggio nell'interfaccia React/Three.js.

### 2.1 Struttura

```
Facility
└── Level (levelId, name, index, gridRows, gridColumns)
    └── Partition (partitionId, name, order, gridRows, gridColumns)
        └── Bay (row, column nella griglia del partition)
```

- **Level**: piano fisico del parcheggio (es. Piano Terra, Piano 1)
- **Partition**: suddivisione logica di un livello (es. Zona A, Zona B)
- **Bay**: singolo posto auto, posizionato nella griglia row×column del partition

### 2.2 Paradigma Unificato

La matrice 3D è **unificata** — non divisa per camera. Bay provenienti da camere diverse possono coesistere nello stesso livello e partition. L'associazione bay→camera è determinata esclusivamente dalle `CameraObservationPolygon`.

Esempio:
```
Level "Piano Terra"
├── Partition "Zona A"
│   ├── B01 (osservato da PTL3)
│   ├── B02 (osservato da PTL3)
│   └── B03 (osservato da PTL3 e PL2.1 — shared bay)
└── Partition "Zona B"
    ├── B17 (osservato da PL2.1)
    └── B18 (osservato da PL2.1)
```

### 2.3 Regole di Visualizzazione

| Condizione | Comportamento nella matrice 3D |
|------------|-------------------------------|
| Bay con ≥1 observation polygon | Mostrata come attiva, colorata in base allo stato |
| Bay senza observation polygons | **Non mostrata** come attiva (nessuna predizione possibile) |
| Bay con override manuale | Lo stato override prevale sulla predizione |

---

## 3. Flusso Editor

### 3.1 Creazione Bay e Polygon

1. L'utente apre l'editor con una camera selezionata (es. `PTL3`)
2. Nella **Matrix Plane** definisce livelli con righe e colonne
3. Seleziona un'entrata nella griglia → viene creato:
   - Una `SpatialBayDefinition` (entità astratta: id, label, row, column, levelId, partitionId)
   - Una `CameraObservationPolygon` (collegamento: canonicalBayId → bay.id, cameraId → camera corrente, imagePolygon)
4. L'utente posiziona/aggiusta il poligono sull'immagine della camera
5. Cambia camera (es. `PL2.1`), crea altri piani/bay → nuove observation su altra camera
6. Salva → tutte le bay e observation vengono persistite nella configurazione globale

### 3.2 Bay Condivise (Shared Bays) — TODO

Una bay può essere osservata da più camere. Il flusso previsto:

1. L'utente crea una bay su Camera A
2. La contrassegna come **"shared"**
3. Seleziona Camera B come camera aggiuntiva
4. Viene creata automaticamente una seconda `CameraObservationPolygon` su Camera B
5. L'utente cambia la visuale sull'immagine di Camera B e aggiusta il poligono
6. Salva → la bay ha ora 2 observation polygons su 2 camere diverse

Nella scheda di ispezione della bay dalla matrice 3D, entrambe le observation sono visibili.

---

## 4. Flusso di Salvataggio

### 4.1 Salvataggio Corretto (Target)

Il salvataggio deve essere **additivo**: salvare i dati della Camera A non deve cancellare i dati della Camera B.

```
Frontend (Camera A selezionata)
│
├─ GET /api/editor/cameras/PTL3/bundle
│  → riceve: bundle.selected (config GLOBALE proiettata su PTL3)
│
├─ Utente modifica poligoni per PTL3
│
├─ Merge locale:
│  ├─ Observation polygons di PTL3: aggiornate con le modifiche
│  ├─ Observation polygons di ALTRE camere: preservate dal baseConfig
│  ├─ Bays: tutte preservate, aggiornate dove necessario
│  └─ Lines, zones, levels, partitions: preservati
│
└─ POST /api/spatial-configs/PTL3/versions
   → payload: config COMPLETA (tutte le camere)
   → backend salva come nuova versione globale
```

### 4.2 Bug Attuale

**Problema**: `getEditorBundle` restituisce `bundle.selected` che è il risultato di `project_config_to_camera()` — una config **filtrata** che contiene solo le bay e observation della camera corrente. Quando il frontend usa questa come `baseConfig` per il merge:

1. `baseConfig.observationPolygons` contiene solo i poligoni della camera corrente
2. `mergeObservationPolygons()` tenta di preservare `polygon.cameraId !== currentCameraId` — ma non ce ne sono nel baseConfig filtrato
3. `baseConfig.bays` contiene solo le bay della camera corrente
4. Il payload inviato al backend contiene solo i dati della camera corrente
5. Il backend sostituisce l'intera configurazione globale → **i dati delle altre camere vengono persi**

**Root cause**: `project_config_to_camera()` filtra i dati prima che il frontend possa fare il merge.

### 4.3 Fix Necessario

Il `baseConfig` passato al frontend deve contenere i dati **globali** (non filtrati). Due approcci possibili:

**Approccio A** — Backend restituisce config globale come baseConfig:
- `getEditorBundle` include un campo `globalConfig` non filtrato
- Il frontend usa `globalConfig` come base per il merge
- `selected` rimane filtrato per la visualizzazione nell'editor

**Approccio B** — Il merge avviene nel backend:
- Il frontend invia solo i dati della camera corrente
- Il backend fa il merge con la configurazione globale esistente
- Più sicuro (single source of truth nel backend)

> **Raccomandazione**: Approccio B — il backend è l'unica fonte di verità.

---

## 5. Proiezione Camera (`project_config_to_camera`)

Questa funzione prende la configurazione globale e restituisce una vista filtrata per una singola camera:

```python
project_config_to_camera(global_config, camera_id) → camera_config
```

**Cosa filtra**:
- `bays` → solo bay dove `cameraId == camera_id` o `camera_id in sourceCameraIds`
- `observationPolygons` → solo dove `cameraId == camera_id`
- `frames` → solo dove `cameraId == camera_id`
- `lines` → solo dove `cameraId == camera_id`
- `zones` → solo zone che contengono almeno una bay filtrata

**Dopo la migrazione** (quando `bay.cameraId` viene rimosso):
- `bays` → solo bay che hanno almeno una `CameraObservationPolygon` con `cameraId == camera_id`
- Il resto rimane invariato

---

## 6. Flusso di Predizione

### 6.1 Pipeline

```
Per ogni camera:
1. Carica frame corrente
2. project_config_to_camera(global, camera_id) → camera_config
3. Per ogni observation polygon della camera:
   a. Crop dell'immagine usando imagePolygon (bounding box del poligono)
   b. Resize a 128×128
   c. Forward pass del modello (ROI classifier)
   d. Output: { bayId, occupied, confidence }
4. Raccogli predizioni per bay_id
```

### 6.2 Aggregazione Multi-Camera

Quando una bay ha observation su più camere:

```
Bay B03:
├── Observation da PTL3: occupied=true,  confidence=0.92
└── Observation da PL2.1: occupied=true, confidence=0.87

→ Predizione finale: occupied=true, confidence=0.92 (highest confidence wins)
```

**Regole**:
- La predizione con **confidenza più alta** determina lo stato della bay
- **Entrambe** le predizioni sono visibili nella scheda di ispezione della bay
- I campi `BayState.winningCameraId` e `BayState.winningPolygonId` indicano quale observation ha vinto
- `BayState.sourceCameraIds` e `BayState.sourcePolygonIds` elencano tutte le fonti

### 6.3 Stabilizzazione

Un debounce di 2 frame previene il flickering:
- Lo stato cambia solo dopo che la predizione è consistente per 2 frame consecutivi
- Questo è post-processing, non parte del modello

---

## 7. Modelli ML

### 7.1 Architettura Corrente (RCNN)

- Backbone: ResNet50 (pretrained ImageNet)
- Input: crop 128×128 dal poligono
- Output: 2 classi (free/occupied)
- Inference: ~40-70ms per batch di 20 bay

### 7.2 Backbone in Valutazione

| Backbone | Parametri | F1 (5K test) | CPU batch=20 |
|----------|-----------|-------------|-------------|
| ResNet50 | 25.6M | ~98% | 767ms |
| ResNet101 | 44.5M | ~98% | 1240ms |
| EfficientNet-B3 | 12.2M | ~98% | 819ms |
| ConvNeXt-Small | 50.2M | ~98% | 514ms |

Training completo su PKLot + CNRPark in corso su Colab.

---

## 8. Struttura File Backend

```
backend/
├── models.py                          — Pydantic models (SpatialBayDefinition, CameraObservationPolygon, etc.)
├── predictor.py                       — OccupancyPredictor (ROI classifier wrapper)
├── predictor_protocol.py              — BayPrediction + OccupancyPredictor Protocol
├── model/
│   ├── rcnn.py                        — RCNN model definition
│   ├── pooling.py                     — ROI pooling (crop + resize)
│   └── occupancy_*.pt                 — Trained weights
├── runtime/
│   ├── spatial_config.py              — normalize, project_config_to_camera, migrate
│   ├── config_repository.py           — Versioned JSON storage + manifest
│   ├── service.py                     — DemoService (editor, save, activate)
│   ├── pipeline.py                    — LivePipelineService (prediction loop)
│   └── bootstrap_layout.py            — Default config generation
└── vision/
    ├── detector.py                    — YOLO11s wrapper (non usato nel flusso ROI)
    └── tracker.py                     — ByteTrack wrapper (non usato nel flusso ROI)
```

---

## 9. API Endpoints Rilevanti

| Metodo | Endpoint | Descrizione |
|--------|----------|-------------|
| GET | `/api/editor/cameras/{id}/bundle` | Bundle editor (config proiettata + lot definition) |
| POST | `/api/spatial-configs/{id}/versions` | Salva nuova versione config |
| PUT | `/api/editor/cameras/{id}/presets/{ver}` | Aggiorna versione esistente |
| POST | `/api/spatial-configs/{id}/activate` | Attiva una versione |
| POST | `/api/editor/cameras/{id}/presets/clone` | Clona preset da altra camera |

---

## 10. Migrazione Dati

### Stato attuale dei dati (v5)

| Camera | Bay | bay.imagePolygon | Observation Polygons |
|--------|-----|-----------------|---------------------|
| PTL3 | B01-B16 | ✅ presenti | ❌ mancanti |
| PL2.1 | B17-B20 | ✅ presenti | ❌ mancanti |
| PTL4 | B21-B23 | ✅ presenti | ✅ presenti (identici) |

### Migrazione necessaria

1. Per ogni bay che ha `imagePolygon` e `cameraId` ma nessuna observation polygon:
   - Creare una `CameraObservationPolygon` con i dati di `bay.imagePolygon` e `bay.cameraId`
2. Dopo la migrazione, tutti i poligoni sono nelle observation polygons
3. Rimuovere `imagePolygon`, `cameraId`, `sourceCameraIds` da `SpatialBayDefinition`
4. Aggiornare `project_config_to_camera()` per filtrare bay tramite observation polygons
5. Aggiornare il predictor per usare observation polygons invece di `bay.imagePolygon`
