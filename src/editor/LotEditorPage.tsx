import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { useParkingClient } from "../api/parkingClientContext";
import { createBlankLotDefinition, DEFAULT_STARTER_CAMERA_ID } from "../data/starterLot";
import {
  createLevelDefinition,
  getLotCameras,
  getLotLevels,
  syncLotDefinition,
} from "../data/lotMatrix";
import { createRectanglePolygon, setPolygonVertex, translatePolygon } from "../data/polygon";
import type {
  EditorCameraBundle,
  LayoutPartitionDefinition,
  LotCameraDefinition,
  LotDefinition,
  LotLevelDefinition,
  LotSlotDefinition,
} from "../data/types";
import { EditablePolygonCanvas } from "./EditablePolygonCanvas";
import { MatrixLayoutEditor } from "./MatrixLayoutEditor";
import { presetIdToVersion, resolvePresetSaveResolution } from "./presetPersistence";
import {
  buildEditableLotDefinition,
  cloneLotDefinition,
  getMaxVersion,
  hydrateLotDefinitionForCamera,
  syncEditableObservationPolygonsForCamera,
  lotDefinitionToSpatialConfig,
} from "./editorLotAdapters";
import { resolveEditorSelection } from "./editorSelection";

const MIN_ZOOM = 0.7;
const MAX_ZOOM = 3;

interface LotEditorPageProps {
  onClose(): void;
}

interface PresetRecord {
  id: string;
  name: string;
  cameraId: string;
  lotDefinition: LotDefinition | null;
  savedLotDefinition: LotDefinition | null;
  sourceVersion: number | null;
  persisted: boolean;
  dirty: boolean;
}

export function LotEditorPage({ onClose }: LotEditorPageProps) {
  const client = useParkingClient();
  const liveSnapshot = useSyncExternalStore(
    client.live.subscribe,
    client.live.getSnapshot,
    client.live.getSnapshot,
  );
  const [lotDefinition, setLotDefinition] = useState<LotDefinition | null>(null);
  const [selectedSlotId, setSelectedSlotId] = useState<string | null>(null);
  const [selectedLevelId, setSelectedLevelId] = useState<string | null>(null);
  const [selectedPartitionId, setSelectedPartitionId] = useState<string | null>(null);
  const [selectedCameraId, setSelectedCameraId] = useState<string | null>(null);
  const [selectedPresetId, setSelectedPresetId] = useState<string | null>(null);
  const [currentFrameId, setCurrentFrameId] = useState<string>("");
  const [imageZoom, setImageZoom] = useState(1);
  const [imageViewResetKey, setImageViewResetKey] = useState(0);
  const [isPolygonEditing, setIsPolygonEditing] = useState(false);
  const [pendingAction, setPendingAction] = useState<"save" | "apply" | null>(null);
  const [saveMessage, setSaveMessage] = useState(
    "Select a camera feed, define the matrix and ROIs, then save the config to make it persistent.",
  );
  const [cameraPresets, setCameraPresets] = useState<Record<string, PresetRecord[]>>({});
  const [cameraBundles, setCameraBundles] = useState<Record<string, EditorCameraBundle>>({});
  const hydratedPresetKeyRef = useRef<string | null>(null);
  const starterLot = useMemo(
    () => createBlankLotDefinition(selectedCameraId ?? liveSnapshot?.activeCameraId ?? liveSnapshot?.cameras[0]?.id ?? DEFAULT_STARTER_CAMERA_ID),
    [liveSnapshot?.activeCameraId, liveSnapshot?.cameras, selectedCameraId],
  );

  useEffect(() => {
    document.body.classList.add("editor-route");
    return () => {
      document.body.classList.remove("editor-route");
    };
  }, []);

  useEffect(() => {
    let active = true;

    const bootstrap = async () => {
      const initialCameraId =
        liveSnapshot?.activeCameraId ?? liveSnapshot?.cameras[0]?.id ?? DEFAULT_STARTER_CAMERA_ID;
      await ensureCameraLoaded(initialCameraId);

      if (!active) {
        return;
      }
    };

    void bootstrap();

    return () => {
      active = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!selectedCameraId) {
      return;
    }

    if (!cameraPresets[selectedCameraId]) {
      void ensureCameraLoaded(selectedCameraId, presetIdToVersion(selectedPresetId) ?? undefined);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedCameraId, selectedPresetId]);

  useEffect(() => {
    if (!selectedCameraId || !selectedPresetId) {
      return;
    }

    const activePresetKey = `${selectedCameraId}:${selectedPresetId}`;
    const preset = cameraPresets[selectedCameraId]?.find((entry) => entry.id === selectedPresetId);
    if (!preset) {
      return;
    }

    if (!preset.lotDefinition && preset.sourceVersion !== null) {
      void ensureCameraLoaded(selectedCameraId, preset.sourceVersion);
      return;
    }

    if (!preset.lotDefinition) {
      return;
    }

    if (hydratedPresetKeyRef.current === activePresetKey) {
      return;
    }

    hydrateEditorLot(preset.lotDefinition, {
      presetKey: activePresetKey,
      cameraId: selectedCameraId,
      resetView: true,
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedCameraId, selectedPresetId, cameraPresets]);

  const editorLot = lotDefinition ? syncLotDefinition(lotDefinition) : null;
  const levels = useMemo(() => (editorLot ? getLotLevels(editorLot) : []), [editorLot]);
  const cameras = useMemo(() => (editorLot ? getLotCameras(editorLot) : []), [editorLot]);
  const partitions = useMemo(
    () =>
      editorLot?.partitions
        .slice()
        .sort((left, right) => left.levelId.localeCompare(right.levelId) || left.order - right.order || left.name.localeCompare(right.name)) ?? [],
    [editorLot],
  );
  const selectedSlot = editorLot?.slots.find((slot) => slot.id === selectedSlotId) ?? null;
  const selectedLevel =
    levels.find((level) => level.id === selectedLevelId) ??
    levels.find((level) => level.id === selectedSlot?.levelId) ??
    levels[0] ??
    null;
  const selectedLevelZones = useMemo(
    () =>
      partitions
        .filter((partition) => partition.levelId === selectedLevel?.id)
        .sort((left, right) => left.order - right.order || left.name.localeCompare(right.name)),
    [partitions, selectedLevel?.id],
  );
  const selectedPartition =
    partitions.find((partition) => partition.id === selectedPartitionId) ??
    pickPartitionForLevel(editorLot, selectedLevel?.id ?? null, null) ??
    partitions.find((partition) => partition.levelId === selectedSlot?.levelId) ??
    partitions[0] ??
    null;
  const selectedCamera =
    cameras.find((camera) => camera.id === selectedCameraId) ??
    cameras[0] ??
    null;
  const currentCameraFrames = selectedCamera
    ? editorLot?.frames.filter((frame) => frame.cameraId === selectedCamera.id) ?? []
    : editorLot?.frames ?? [];
  const currentFrame =
    currentCameraFrames.find((frame) => frame.id === currentFrameId) ??
    currentCameraFrames[0] ??
    editorLot?.frames[0] ??
    null;
  const selectedPartitionSlots = selectedPartition
    ? editorLot?.slots.filter((slot) => slot.partitionId === selectedPartition.id) ?? []
    : [];
  const selectedPartitionCameraSlots = useMemo(
    () => selectedPartitionSlots.filter((slot) => slot.imagePolygonDefined !== false),
    [selectedPartitionSlots],
  );
  const imageCanvasSlots = useMemo(
    () =>
      (selectedPartition ? selectedPartitionSlots : editorLot?.slots ?? []).filter(
        (slot) => slot.imagePolygonDefined !== false,
      ),
    [editorLot?.slots, selectedPartition, selectedPartitionSlots],
  );
  const orderedLevelSlots = useMemo(
    () =>
      [...selectedPartitionCameraSlots].sort(
        (left, right) =>
          left.row - right.row || left.column - right.column || left.label.localeCompare(right.label),
      ),
    [selectedPartitionCameraSlots],
  );
  const imageFrameUrl = currentFrame
    ? resolveEditorFrameUrl(currentFrame.id, currentFrame.imagePath, selectedCamera?.id ?? selectedCameraId)
    : "";
  const summary = useMemo(
    () => ({
      totalSlots: editorLot?.slots.length ?? 0,
      totalLevels: levels.length,
      partitions: partitions.length,
      evSlots: editorLot?.slots.filter((slot) => slot.evCapable).length ?? 0,
      frames: editorLot?.frames.length ?? 0,
      configs:
        new Set(
          Object.values(cameraPresets)
            .flat()
            .map((preset) => preset.id),
        ).size || 1,
      reservedDefaults: editorLot?.slots.filter((slot) => slot.reservedDefault).length ?? 0,
    }),
    [cameraPresets, editorLot, levels.length, partitions.length],
  );
  const selectedSlotCamera = selectedSlot
    ? cameras.find((camera) => camera.id === selectedSlot.cameraId) ?? null
    : null;
  const selectedPartitionForGrid =
    partitions.find((partition) => partition.id === selectedPartition?.id) ?? selectedPartition ?? null;
  const selectedSlotRowOptions = Array.from(
    { length: Math.max(selectedPartitionForGrid?.gridRows ?? 1, 1) },
    (_, index) => index,
  );
  const selectedSlotColumnOptions = Array.from(
    { length: Math.max(selectedPartitionForGrid?.gridColumns ?? 1, 1) },
    (_, index) => index,
  );
  const currentCameraPresetRecords = selectedCameraId ? cameraPresets[selectedCameraId] ?? [] : [];
  const currentPresetId = selectedPresetId ?? currentCameraPresetRecords[0]?.id ?? null;
  const currentPreset = currentCameraPresetRecords.find((entry) => entry.id === currentPresetId) ?? currentCameraPresetRecords[0] ?? null;
  const isCurrentPresetDirty = currentPreset?.dirty ?? false;
  const isSaving = pendingAction === "save";
  const isApplying = pendingAction === "apply";
  const currentActiveVersion =
    selectedCameraId !== null ? cameraBundles[selectedCameraId]?.active.version ?? null : null;
  const currentPresetState = describePresetState(currentPreset, isCurrentPresetDirty, currentActiveVersion);
  const knownCameraIds = useMemo(
    () =>
      Array.from(
        new Set(
          [
            ...cameras.map((camera) => camera.id),
            ...(liveSnapshot?.cameras ?? []).map((camera) => camera.id),
            ...Object.keys(cameraPresets),
            selectedCameraId ?? undefined,
          ].filter((value): value is string => Boolean(value)),
        ),
      ),
    [cameraPresets, cameras, liveSnapshot?.cameras, selectedCameraId],
  );

  useEffect(() => {
    const handleBeforeUnload = (event: BeforeUnloadEvent) => {
      if (!isCurrentPresetDirty) {
        return;
      }

      event.preventDefault();
      event.returnValue = "";
    };

    window.addEventListener("beforeunload", handleBeforeUnload);
    return () => {
      window.removeEventListener("beforeunload", handleBeforeUnload);
    };
  }, [isCurrentPresetDirty]);

  const resetImageView = () => {
    setImageZoom(1);
    setImageViewResetKey((current) => current + 1);
  };

  const updatePresetAcrossKnownCameras = (
    presetId: string,
    recipe: (record: PresetRecord, cameraId: string) => PresetRecord,
    seedRecord?: PresetRecord | null,
    cameraIds: string[] = knownCameraIds,
  ) => {
    setCameraPresets((current) => {
      const next = { ...current };
      const targetCameraIds = cameraIds.length > 0 ? cameraIds : [selectedCameraId ?? DEFAULT_STARTER_CAMERA_ID];

      for (const cameraId of targetCameraIds) {
        const existing =
          next[cameraId]?.find((entry) => entry.id === presetId) ??
          (seedRecord ? { ...seedRecord, cameraId } : null);
        if (!existing) {
          continue;
        }

        next[cameraId] = upsertPreset(next[cameraId] ?? [], recipe(existing, cameraId));
      }

      return next;
    });
  };

  const mutateLot = (recipe: (current: LotDefinition) => LotDefinition) => {
    setLotDefinition((current) => {
      if (!current) {
        return current;
      }

      const mutated = syncLotDefinition(recipe(current));
      const next =
        selectedCameraId !== null
          ? syncEditableObservationPolygonsForCamera(
              mutated,
              selectedCameraId,
              currentPreset?.sourceVersion ?? presetIdToVersion(selectedPresetId) ?? 0,
            )
          : mutated;
      if (selectedPresetId && currentPreset) {
        updatePresetAcrossKnownCameras(
          selectedPresetId,
          (entry, cameraId) => ({
            ...entry,
            cameraId,
            // Only keep the hydrated lotDefinition for the current camera.
            // Other cameras get null so switching forces a fresh fetch with
            // correct observation polygon hydration for that camera.
            lotDefinition: cameraId === selectedCameraId ? next : null,
            dirty: true,
          }),
          currentPreset,
          collectPresetCameraIds(next, knownCameraIds, selectedCameraId),
        );
      }
      return next;
    });
  };

  const updateLevel = (
    levelId: string,
    recipe: (level: LotLevelDefinition) => LotLevelDefinition,
  ) => {
    mutateLot((current) => ({
      ...current,
      levels: getLotLevels(current).map((level) => (level.id === levelId ? recipe(level) : level)),
    }));
  };

  const updatePartition = (
    partitionId: string,
    recipe: (partition: LayoutPartitionDefinition) => LayoutPartitionDefinition,
  ) => {
    mutateLot((current) => ({
      ...current,
      partitions: (current.partitions ?? []).map((partition) =>
        partition.id === partitionId ? recipe(partition) : partition,
      ),
    }));
  };

  const updateCamera = (
    cameraId: string,
    recipe: (camera: LotCameraDefinition) => LotCameraDefinition,
  ) => {
    mutateLot((current) => ({
      ...current,
      cameras: getLotCameras(current).map((camera) => (camera.id === cameraId ? recipe(camera) : camera)),
    }));
  };

  const updateSlot = (slotId: string, recipe: (slot: LotSlotDefinition) => LotSlotDefinition) => {
    mutateLot((current) => ({
      ...current,
      slots: current.slots.map((slot) => (slot.id === slotId ? recipe(slot) : slot)),
    }));
  };

  const syncSelectionFromLot = (nextLot: LotDefinition) => {
    const selection = resolveEditorSelection(nextLot, {
      selectedSlotId,
      selectedLevelId,
      selectedPartitionId,
      selectedCameraId,
    });

    setSelectedSlotId(selection.selectedSlotId);
    setSelectedLevelId(selection.selectedLevelId);
    setSelectedPartitionId(selection.selectedPartitionId);
    setSelectedCameraId(selection.selectedCameraId);
    setCurrentFrameId(selection.currentFrameId);
  };

  const hydrateEditorLot = (
    nextLot: LotDefinition,
    options?: { presetKey?: string | null; cameraId?: string | null; resetView?: boolean },
  ) => {
    setLotDefinition(cloneLotDefinition(nextLot));

    const selection = resolveEditorSelection(
      nextLot,
      {
        selectedSlotId,
        selectedLevelId,
        selectedPartitionId,
        selectedCameraId,
      },
      options?.cameraId ?? null,
    );

    setSelectedSlotId(selection.selectedSlotId);
    setSelectedLevelId(selection.selectedLevelId);
    setSelectedPartitionId(selection.selectedPartitionId);
    setSelectedCameraId(selection.selectedCameraId);
    setCurrentFrameId(selection.currentFrameId);

    if (options?.presetKey !== undefined) {
      hydratedPresetKeyRef.current = options.presetKey;
    }

    if (options?.resetView) {
      resetImageView();
    }
  };

  const ensureCameraLoaded = async (cameraId: string, version?: number) => {
    const preferredVersion = version ?? presetIdToVersion(selectedPresetId) ?? undefined;
    const presetId = preferredVersion !== undefined ? `preset-${preferredVersion}` : null;
    const cachedPreset = presetId
      ? cameraPresets[cameraId]?.find((entry) => entry.id === presetId)
      : (selectedPresetId
          ? cameraPresets[cameraId]?.find((entry) => entry.id === selectedPresetId)
          : null) ?? cameraPresets[cameraId]?.[0];
    if (cachedPreset?.lotDefinition) {
      const videoSource = cameraBundles[cameraId]?.videoSource ?? null;
      const hydratedLot = hydrateLotDefinitionForCamera(
        cachedPreset.lotDefinition,
        liveSnapshot ?? null,
        cameraId,
        videoSource,
      );
      const hydratedSavedLot = cachedPreset.savedLotDefinition
        ? hydrateLotDefinitionForCamera(
            cachedPreset.savedLotDefinition,
            liveSnapshot ?? null,
            cameraId,
            videoSource,
          )
        : null;

      setCameraPresets((current) => ({
        ...current,
        [cameraId]: upsertPreset(current[cameraId] ?? [], {
          ...cachedPreset,
          cameraId,
          lotDefinition: hydratedLot,
          savedLotDefinition: hydratedSavedLot ?? cachedPreset.savedLotDefinition,
        }),
      }));
      setSelectedCameraId(cameraId);
      setSelectedPresetId(cachedPreset.id);
      hydrateEditorLot(hydratedLot, {
        presetKey: `${cameraId}:${cachedPreset.id}`,
        cameraId,
      });
      return hydratedLot;
    }

    try {
      const bundle = await client.configs.getEditorBundle(cameraId, preferredVersion);
      const nextLot = buildEditableLotDefinition(bundle, liveSnapshot ?? null, cameraId);
      const selectedPresetId = `preset-${bundle.selectedVersion}`;
      const records = bundle.versions
        .filter((entry) => entry.status !== "archived")
        .map(
          (entry) =>
            ({
              id: `preset-${entry.version}`,
              name: entry.presetName ?? `Version ${entry.version}`,
              cameraId,
              lotDefinition:
                entry.version === bundle.selectedVersion
                  ? nextLot
                  : cameraPresets[cameraId]?.find((item) => item.id === `preset-${entry.version}`)
                      ?.lotDefinition ?? null,
              savedLotDefinition:
                entry.version === bundle.selectedVersion
                  ? nextLot
                  : cameraPresets[cameraId]?.find((item) => item.id === `preset-${entry.version}`)
                      ?.savedLotDefinition ?? null,
              sourceVersion: entry.version,
              persisted: true,
              dirty: false,
            }) satisfies PresetRecord,
        );

      setCameraBundles((current) => ({
        ...current,
        [cameraId]: bundle,
      }));
      setCameraPresets((current) => ({
        ...current,
        [cameraId]: records,
      }));
      setSelectedCameraId(cameraId);
      setSelectedPresetId(selectedPresetId);
      hydrateEditorLot(nextLot, {
        presetKey: `${cameraId}:${selectedPresetId}`,
        cameraId,
      });
      setSaveMessage(`Loaded ${bundle.selected.presetName ?? `config ${bundle.selectedVersion}`} for ${cameraId}.`);
      return nextLot;
    } catch {
      const fallbackLot = starterLot;
      const record = {
        id: "preset-1",
        name: "Config 01",
        cameraId,
        lotDefinition: fallbackLot,
        savedLotDefinition: fallbackLot,
        sourceVersion: 1,
        persisted: false,
        dirty: false,
      } satisfies PresetRecord;

      setCameraPresets((current) => ({
        ...current,
        [cameraId]: [record],
      }));
      setSelectedCameraId(cameraId);
      setSelectedPresetId(record.id);
      hydrateEditorLot(fallbackLot, {
        presetKey: `${cameraId}:${record.id}`,
        cameraId,
      });
      setSaveMessage("Sidecar not reachable. Editing a blank starter config.");
      return fallbackLot;
    }
  };

  const persistCurrentPreset = async () => {
    if (!selectedCameraId || !editorLot) {
      return null;
    }

    setPendingAction("save");

    try {
      const bundle = await client.configs.getEditorBundle(selectedCameraId, currentPreset?.sourceVersion ?? undefined);
      const now = new Date().toISOString();
      const currentVersion = currentPreset?.sourceVersion ?? bundle.selectedVersion;
      const isPersistedPreset = currentPreset?.persisted === true && currentPreset.sourceVersion !== null;
      const saveResolution = resolvePresetSaveResolution({
        isPersistedPreset,
        currentVersion,
        activeVersion: bundle.active.version,
        maxVersion: getMaxVersion(bundle.versions),
        selectedCreatedAt: bundle.selected.createdAt,
        selectedActivatedAt: bundle.selected.activatedAt ?? null,
        now,
        cameraId: selectedCameraId,
      });
      const { shouldForkActivePreset, targetVersion } = saveResolution;
      const restoredSourceLot = shouldForkActivePreset
        ? buildEditableLotDefinition(bundle, liveSnapshot ?? null, selectedCameraId)
        : null;
      const spatialConfig = lotDefinitionToSpatialConfig(editorLot, {
        cameraId: selectedCameraId,
        version: targetVersion,
        status: "draft",
        baseConfig: bundle.selected,
        createdAt: saveResolution.createdAt,
        updatedAt: now,
        activatedAt: saveResolution.activatedAt,
      });
      const resolvedPresetName = normalizePresetName(
        currentPreset?.name,
        bundle.selected.presetName ?? `Config ${String(targetVersion).padStart(2, "0")}`,
      );
      spatialConfig.presetName = resolvedPresetName;
      if (saveResolution.copiedFromCameraId) {
        spatialConfig.copiedFromCameraId = saveResolution.copiedFromCameraId;
        spatialConfig.copiedFromVersion = saveResolution.copiedFromVersion;
      }

      if (isPersistedPreset && !shouldForkActivePreset) {
        await client.configs.updatePreset(selectedCameraId, targetVersion, spatialConfig);
      } else {
        await client.configs.saveDraft(selectedCameraId, spatialConfig);
      }

      const refreshedBundle = await client.configs.getEditorBundle(selectedCameraId, targetVersion);
      const refreshedLot = buildEditableLotDefinition(refreshedBundle, liveSnapshot ?? null, selectedCameraId);
      const presetRecord: PresetRecord = {
        id: `preset-${targetVersion}`,
        name: normalizePresetName(
          refreshedBundle.selected.presetName,
          resolvedPresetName,
        ),
        cameraId: selectedCameraId,
        lotDefinition: refreshedLot,
        savedLotDefinition: refreshedLot,
        sourceVersion: targetVersion,
        persisted: true,
        dirty: false,
      };

      setCameraBundles((current) => ({
        ...current,
        [selectedCameraId]: refreshedBundle,
      }));
      setCameraPresets((current) => {
        const targetCameraIds = collectPresetCameraIds(refreshedLot, knownCameraIds, selectedCameraId);
        let next = replacePresetAcrossCameras(
          current,
          targetCameraIds,
          presetRecord,
          currentPreset?.id ?? null,
          selectedCameraId,
        );

        if (shouldForkActivePreset && currentPreset?.sourceVersion && restoredSourceLot) {
          next = replacePresetAcrossCameras(
            next,
            collectPresetCameraIds(restoredSourceLot, knownCameraIds, selectedCameraId),
            {
              id: currentPreset.id,
              name: normalizePresetName(bundle.selected.presetName, currentPreset.name),
              cameraId: selectedCameraId,
              lotDefinition: restoredSourceLot,
              savedLotDefinition: restoredSourceLot,
              sourceVersion: currentPreset.sourceVersion,
              persisted: true,
              dirty: false,
            },
            null,
            selectedCameraId,
          );
        }

        return next;
      });
      setSelectedPresetId(presetRecord.id);
      hydrateEditorLot(refreshedLot, {
        presetKey: `${selectedCameraId}:${presetRecord.id}`,
        cameraId: selectedCameraId,
        resetView: true,
      });
      setSaveMessage(
        shouldForkActivePreset
          ? `Saved ${presetRecord.name} as a draft config. Apply it to live when ready.`
          : `Saved ${presetRecord.name}.`,
      );
      return presetRecord;
    } catch {
      setSaveMessage("Saving the config failed. The sidecar must be running for persistence.");
      return null;
    } finally {
      setPendingAction(null);
    }
  };

  const discardCurrentPresetChanges = async () => {
    if (!selectedCameraId || !currentPreset) {
      return false;
    }

    const savedLot = currentPreset.savedLotDefinition
      ? cloneLotDefinition(currentPreset.savedLotDefinition)
      : null;

    if (!savedLot && currentPreset.sourceVersion !== null) {
      await ensureCameraLoaded(selectedCameraId, currentPreset.sourceVersion);
      resetImageView();
      return true;
    }

    if (!savedLot) {
      return false;
    }

    setCameraPresets((current) => ({
      ...current,
      [selectedCameraId]: (current[selectedCameraId] ?? []).map((entry) =>
        entry.id === currentPreset.id
          ? {
              ...entry,
              lotDefinition: savedLot,
              dirty: false,
            }
          : entry,
      ),
    }));
    hydrateEditorLot(savedLot, {
      presetKey: selectedCameraId && currentPreset ? `${selectedCameraId}:${currentPreset.id}` : null,
      cameraId: selectedCameraId,
      resetView: true,
    });
    setSaveMessage(`Discarded unsaved changes in ${currentPreset.name}.`);
    return true;
  };

  const resolveDirtyTransition = async (
    actionLabel: string,
  ): Promise<{ proceed: boolean; savedPreset: PresetRecord | null }> => {
    if (!isCurrentPresetDirty) {
      return {
        proceed: true,
        savedPreset: null,
      };
    }

    const shouldSave = window.confirm(
      `Save changes to ${currentPreset?.name ?? "this config"} before ${actionLabel}? Click OK to save, or Cancel to choose whether to discard them.`,
    );
    if (shouldSave) {
      const savedPreset = await persistCurrentPreset();
      return {
        proceed: Boolean(savedPreset),
        savedPreset,
      };
    }

    const shouldDiscard = window.confirm(
      `Discard unsaved changes to ${currentPreset?.name ?? "this config"} and continue ${actionLabel}?`,
    );
    if (!shouldDiscard) {
      return {
        proceed: false,
        savedPreset: null,
      };
    }

    return {
      proceed: await discardCurrentPresetChanges(),
      savedPreset: null,
    };
  };

  const handleSelectSlot = async (slotId: string | null) => {
    if (!slotId) {
      setSelectedSlotId(null);
      return;
    }

    const nextSlot = editorLot?.slots.find((slot) => slot.id === slotId) ?? null;
    if (!nextSlot) {
      return;
    }

    const currentCameraKey = selectedCamera?.id ?? selectedCameraId ?? null;
    // If this bay has no polygon on the current camera but has one on
    // another camera, switch the frame to show the existing polygon.
    const observationCameraId =
      nextSlot.imagePolygonDefined === false
        ? resolveObservationCameraId(nextSlot, editorLot, currentCameraKey)
        : null;
    if (observationCameraId) {
      const transition = await resolveDirtyTransition("showing this bay on its mapped camera");
      if (!transition.proceed) {
        return;
      }

      const preferredVersion =
        transition.savedPreset?.sourceVersion ??
        currentPreset?.sourceVersion ??
        presetIdToVersion(selectedPresetId) ??
        undefined;
      const loaded = await ensureCameraLoaded(observationCameraId, preferredVersion);
      setSelectedSlotId(nextSlot.id);
      if (loaded) {
        setCurrentFrameId(loaded.frames[0]?.id ?? "");
      }
      setSaveMessage(`Showing ${nextSlot.label} on ${observationCameraId}.`);
      return;
    }

    setSelectedSlotId(nextSlot.id);

    setSelectedLevelId(nextSlot.levelId);
    setSelectedPartitionId(nextSlot.partitionId);

    if (nextSlot.imagePolygonDefined === false) {
      updateSlot(nextSlot.id, (slot) => ({
        ...slot,
        imagePolygonDefined: true,
        imagePolygon:
          slot.imagePolygon.length > 0
            ? slot.imagePolygon
            : createRectanglePolygon(0.5, 0.5, 0.11, 0.16),
      }));
      setIsPolygonEditing(true);
      setSaveMessage(`Created a new ROI for ${nextSlot.label} on ${selectedCameraId ?? nextSlot.cameraId}.`);
    }
  };

  const handleSelectLevel = async (levelId: string) => {
    setSelectedLevelId(levelId);
    setSelectedPartitionId(
      pickPartitionForLevel(editorLot, levelId, null)?.id ??
        selectedPartition?.id ??
        null,
    );

    if (selectedSlot?.levelId !== levelId) {
      setSelectedSlotId(null);
    }
  };

  const handleSelectZone = (partitionId: string) => {
    setSelectedPartitionId(partitionId);
    const nextZone = partitions.find((partition) => partition.id === partitionId) ?? null;
    if (!nextZone) {
      return;
    }

    setSelectedLevelId(nextZone.levelId);
    if (selectedSlot?.partitionId !== partitionId) {
      setSelectedSlotId(null);
    }
  };

  const handleSelectCamera = async (cameraId: string) => {
    const nextCamera = cameras.find((camera) => camera.id === cameraId) ?? null;
    if (!nextCamera) {
      return;
    }

    let preferredVersion =
      currentPreset?.sourceVersion ??
      presetIdToVersion(selectedPresetId) ??
      undefined;

    if (nextCamera.id !== selectedCameraId) {
      const transition = await resolveDirtyTransition("switching camera feeds");
      if (!transition.proceed) {
        return;
      }
      preferredVersion =
        transition.savedPreset?.sourceVersion ??
        preferredVersion;
    }

    setSelectedCameraId(nextCamera.id);
    // Keep the current level/partition — the matrix is shared across all
    // cameras.  Only the video frame changes when switching cameras.
    setSelectedSlotId(null);
    const loaded = await ensureCameraLoaded(nextCamera.id, preferredVersion);
    if (loaded) {
      setCurrentFrameId(loaded.frames[0]?.id ?? "");
    }
    resetImageView();
  };

  const handleCreateSlot = (
    levelId: string,
    partitionId: string,
    row: number,
    column: number,
    template?: LotSlotDefinition,
  ) => {
    const targetPartition = partitions.find((partition) => partition.id === partitionId) ?? null;
    const targetCameraId =
      template?.cameraId ??
      targetPartition?.ownerCameraIds[0] ??
      selectedCamera?.id ??
      cameras.find((camera) => camera.levelId === levelId)?.id ??
      editorLot?.camera.id ??
      starterLot.camera.id;
    const nextIndex = getNextSlotNumber(editorLot ?? starterLot);
    const nextSlot: LotSlotDefinition = {
      id: formatSlotId(nextIndex),
      label: formatSlotLabel(nextIndex),
      row,
      column,
      levelId,
      partitionId: partitionId || targetPartition?.id || levelId,
      cameraId: targetCameraId,
      imagePolygon: template?.imagePolygon
        ? translatePolygon(template.imagePolygon, 0.015, 0)
        : createRectanglePolygon(0.5, 0.5, 0.11, 0.16),
      imagePolygonDefined: true,
      layoutPolygon: createRectanglePolygon(0.5, 0.5, 0.11, 0.16),
      evCapable: template?.evCapable ?? false,
      reservedDefault: template?.reservedDefault ?? false,
      ownerCameraIds: targetPartition?.ownerCameraIds?.length ? [...targetPartition.ownerCameraIds] : [targetCameraId],
    };

    mutateLot((current) => ({
      ...current,
      slots: [...current.slots, nextSlot],
    }));
    setSelectedLevelId(levelId);
    setSelectedPartitionId(nextSlot.partitionId);
    setSelectedCameraId(targetCameraId);
    setSelectedSlotId(nextSlot.id);
    setSaveMessage(`Created ${nextSlot.label} on ${levels.find((level) => level.id === levelId)?.name ?? levelId}.`);
  };

  const handleAddLevel = () => {
    const nextLevel = createLevelDefinition(levels.length);
    const nextPartition = createPartitionDefinition(nextLevel, 0, []);
    mutateLot((current) => ({
      ...current,
      levels: [...getLotLevels(current), nextLevel],
      partitions: [...(current.partitions ?? []), nextPartition],
    }));
    setSelectedLevelId(nextLevel.id);
    setSelectedPartitionId(nextPartition.id);
    setSelectedSlotId(null);
    setSaveMessage(`Added ${nextLevel.name}. Select a zone, then create bays on its matrix.`);
  };

  const handleAddZone = () => {
    if (!selectedLevel) {
      return;
    }

    const nextPartition = createPartitionDefinition(
      selectedLevel,
      selectedLevelZones.length,
      [],
    );

    mutateLot((current) => ({
      ...current,
      partitions: [...(current.partitions ?? []), nextPartition],
    }));
    setSelectedPartitionId(nextPartition.id);
    setSelectedSlotId(null);
    setSaveMessage(`Added ${nextPartition.name} on ${selectedLevel.name}.`);
  };

  const handleDeleteZone = () => {
    if (!selectedPartition || !selectedLevel || selectedLevelZones.length <= 1) {
      return;
    }

    const remainingPartitions = partitions.filter((partition) => partition.id !== selectedPartition.id);
    const fallbackZone =
      remainingPartitions.find((partition) => partition.levelId === selectedLevel.id) ??
      remainingPartitions[0] ??
      null;
    const remainingSlots = editorLot?.slots.filter((slot) => slot.partitionId !== selectedPartition.id) ?? [];
    const fallbackSlot =
      remainingSlots.find((slot) => slot.partitionId === fallbackZone?.id) ??
      remainingSlots.find((slot) => slot.levelId === selectedLevel.id) ??
      remainingSlots[0] ??
      null;

    mutateLot((current) => ({
      ...current,
      partitions: (current.partitions ?? []).filter((partition) => partition.id !== selectedPartition.id),
      slots: current.slots.filter((slot) => slot.partitionId !== selectedPartition.id),
    }));

    setSelectedPartitionId(fallbackZone?.id ?? null);
    setSelectedSlotId(fallbackSlot?.id ?? null);
    setSaveMessage(`Deleted ${selectedPartition.name} from ${selectedLevel.name}.`);
  };

  const handleMoveLevel = (direction: -1 | 1) => {
    if (!selectedLevel) {
      return;
    }

    const currentIndex = levels.findIndex((level) => level.id === selectedLevel.id);
    const nextIndex = currentIndex + direction;
    if (nextIndex < 0 || nextIndex >= levels.length) {
      return;
    }

    const reordered = [...levels];
    const [moved] = reordered.splice(currentIndex, 1);
    reordered.splice(nextIndex, 0, moved);

    mutateLot((current) => ({
      ...current,
      levels: reordered.map((level, index) => ({ ...level, index })),
    }));
    setSelectedLevelId(selectedLevel.id);
  };

  const handleDeleteLevel = () => {
    if (!selectedLevel || levels.length <= 1) {
      return;
    }

    const remainingLevels = levels
      .filter((level) => level.id !== selectedLevel.id)
      .map((level, index) => ({ ...level, index }));
    const fallbackLevelId = remainingLevels[0]?.id ?? null;
    const remainingPartitions = partitions.filter((partition) => partition.levelId !== selectedLevel.id);
    const remainingSlots = editorLot?.slots.filter((slot) => slot.levelId !== selectedLevel.id) ?? [];

    mutateLot((current) => ({
      ...current,
      levels: remainingLevels,
      partitions: remainingPartitions,
      cameras: getLotCameras(current).map((camera) =>
        camera.levelId === selectedLevel.id && fallbackLevelId
          ? { ...camera, levelId: fallbackLevelId }
          : camera,
      ),
      slots: remainingSlots,
    }));
    setSelectedLevelId(fallbackLevelId);
    setSelectedPartitionId(
      remainingPartitions.find((partition) => partition.levelId === fallbackLevelId)?.id ?? null,
    );
    setSelectedSlotId(remainingSlots[0]?.id ?? null);
  };

  const handleCloneCameraSet = async () => {
    const transition = await resolveDirtyTransition("cloning a config");
    if (!transition.proceed) {
      return;
    }

    const sourceCameraId = selectedCameraId ?? selectedCamera?.id ?? null;
    const sourceVersion = currentPreset?.sourceVersion ?? null;
    if (!sourceCameraId || !sourceVersion) {
      return;
    }

    const targetCameraId = selectedCameraId ?? sourceCameraId;
    const cloned = await client.configs.clonePreset(targetCameraId, {
      sourceCameraId,
      sourceVersion,
      targetName: `${currentPreset?.name ?? "Config"} copy`,
      activate: false,
    });

    await ensureCameraLoaded(targetCameraId, cloned.version);
    setSelectedSlotId(null);
    setSaveMessage(`Cloned ${currentPreset?.name ?? "the config"} into ${targetCameraId}. The draft is ready for editing.`);
    resetImageView();
  };

  const handleDeleteCameraSet = async () => {
    if (!selectedCameraId || !currentPreset?.sourceVersion || currentCameraPresetRecords.length <= 1) {
      return;
    }

    const transition = await resolveDirtyTransition("deleting this config");
    if (!transition.proceed) {
      return;
    }

    await client.configs.deletePreset(selectedCameraId, currentPreset.sourceVersion);
    const remainingPresets = currentCameraPresetRecords.filter(
      (entry) => entry.sourceVersion !== currentPreset.sourceVersion,
    );
    setCameraPresets((current) => ({
      ...current,
      [selectedCameraId]: remainingPresets,
    }));

    const fallbackPreset = remainingPresets[0] ?? null;
    if (fallbackPreset?.sourceVersion) {
      await ensureCameraLoaded(selectedCameraId, fallbackPreset.sourceVersion);
    } else {
      setSelectedPresetId(null);
    }
    setSelectedSlotId(null);
    setSaveMessage(`Deleted ${currentPreset.name}.`);
    resetImageView();
  };

  const handleAddSlot = () => {
    const activeLevel = selectedLevel ?? levels[0];
    const activePartition = selectedPartition ?? partitions.find((partition) => partition.levelId === activeLevel?.id) ?? null;
    if (!activeLevel) {
      return;
    }

    if (!activePartition) {
      return;
    }

    const nextCell = findNextAvailableCell(activePartition.id, editorLot ?? starterLot);
    if (!nextCell) {
      setSaveMessage(
        `${activePartition.name || activeLevel.name} is full. Increase grid rows or columns before adding another bay.`,
      );
      return;
    }
    handleCreateSlot(activeLevel.id, activePartition.id, nextCell.row, nextCell.column);
  };

  const handleDuplicateSlot = () => {
    if (!selectedSlot) {
      return;
    }

    const nextCell = findNextAvailableCell(selectedSlot.partitionId, editorLot ?? starterLot);
    if (!nextCell) {
      setSaveMessage(
        `${selectedPartition?.name ?? selectedSlot.partitionId} is full. Expand the grid before duplicating this bay.`,
      );
      return;
    }
    handleCreateSlot(selectedSlot.levelId, selectedSlot.partitionId, nextCell.row, nextCell.column, selectedSlot);
  };

  const handleDeleteSlot = () => {
    if (!selectedSlot) {
      return;
    }

    mutateLot((current) => ({
      ...current,
      slots: current.slots.filter((slot) => slot.id !== selectedSlot.id),
    }));
    setSelectedSlotId(null);
  };

  const handleSelectFrame = async (frameId: string) => {
    setCurrentFrameId(frameId);
    resetImageView();
  };

  const handleSelectPreset = async (presetId: string) => {
    if (presetId === selectedPresetId) {
      return;
    }

    const transition = await resolveDirtyTransition("switching configs");
    if (!transition.proceed) {
      return;
    }

    setSelectedPresetId(presetId);
  };

  const handleConfigNameChange = (nextName: string) => {
    if (!selectedPresetId || !currentPreset) {
      return;
    }

    if (nextName === currentPreset.name) {
      return;
    }

    updatePresetAcrossKnownCameras(
      selectedPresetId,
      (entry, cameraId) => ({
        ...entry,
        cameraId,
        name: nextName,
        dirty: true,
      }),
      currentPreset,
    );
    setSaveMessage(
      nextName.trim().length > 0
        ? `Renamed the config to ${nextName.trim()}. Save to persist the change.`
        : "Config name cleared. Save to persist the change.",
    );
  };

  const handleCreateBlankConfig = async () => {
    if (!selectedCameraId) {
      return;
    }

    const transition = await resolveDirtyTransition("creating a new blank config");
    if (!transition.proceed) {
      return;
    }

    const baseLot = editorLot ?? starterLot;
    const nextVersion =
      Math.max(
        0,
        ...Object.values(cameraPresets)
          .flat()
          .map((preset) => preset.sourceVersion ?? 0),
      ) + 1;
    const nextName = `Config ${String(nextVersion).padStart(2, "0")}`;
    const blankLot = createBlankLotDefinition(selectedCameraId, {
      facilityId: baseLot.facilityId,
      facilityName: baseLot.facilityName,
      timeZone: baseLot.timeZone,
      cameras: baseLot.cameras,
      frames: baseLot.frames,
    });
    const draftId = `draft-${Date.now()}`;
    const draftRecord: PresetRecord = {
      id: draftId,
      name: nextName,
      cameraId: selectedCameraId,
      lotDefinition: blankLot,
      savedLotDefinition: blankLot,
      sourceVersion: null,
      persisted: false,
      dirty: true,
    };

    setCameraPresets((current) =>
      replacePresetAcrossCameras(
        current,
        collectPresetCameraIds(blankLot, knownCameraIds, selectedCameraId),
        draftRecord,
        null,
        selectedCameraId,
      ),
    );
    setSelectedPresetId(draftId);
    hydrateEditorLot(blankLot, {
      presetKey: `${selectedCameraId}:${draftId}`,
      cameraId: selectedCameraId,
      resetView: true,
    });
    setSelectedSlotId(null);
    setSaveMessage(`Created ${nextName}. Save the config to persist it across restarts.`);
  };

  const handleStepFrame = (direction: -1 | 1) => {
    if (!currentFrame) {
      return;
    }

    const index = currentCameraFrames.findIndex((frame) => frame.id === currentFrame.id);
    const next = currentCameraFrames[Math.min(Math.max(index + direction, 0), currentCameraFrames.length - 1)];
    if (next) {
      void handleSelectFrame(next.id);
    }
  };

  const handleZoomChange = (nextZoom: number) => {
    setImageZoom(clampZoom(nextZoom));
  };

  const relocateSlot = (
    slotId: string,
    nextPosition: { levelId?: string; partitionId?: string; row?: number; column?: number; cameraId?: string },
  ) => {
    mutateLot((current) => {
      const levelsById = new Map(getLotLevels(current).map((level) => [level.id, level] as const));
      const partitionsById = new Map((current.partitions ?? []).map((partition) => [partition.id, partition] as const));
      const cameraIds = new Set(getLotCameras(current).map((camera) => camera.id));
      const sourceSlot = current.slots.find((slot) => slot.id === slotId);
      if (!sourceSlot) {
        return current;
      }

      const sourceLevel = levelsById.get(sourceSlot.levelId);
      const targetLevelId = nextPosition.levelId ?? sourceSlot.levelId;
      const targetLevel = levelsById.get(targetLevelId) ?? sourceLevel;
      if (!targetLevel) {
        return current;
      }

      const targetRow = clampGridIndex(nextPosition.row ?? sourceSlot.row, targetLevel.gridRows);
      const targetColumn = clampGridIndex(nextPosition.column ?? sourceSlot.column, targetLevel.gridColumns);
      const sourceRow = clampGridIndex(sourceSlot.row, sourceLevel?.gridRows ?? 1);
      const sourceColumn = clampGridIndex(sourceSlot.column, sourceLevel?.gridColumns ?? 1);
      const targetCameraId =
        nextPosition.cameraId && cameraIds.has(nextPosition.cameraId)
          ? nextPosition.cameraId
          : sourceSlot.cameraId;
      const targetPartitionId =
        nextPosition.partitionId && partitionsById.has(nextPosition.partitionId)
          ? nextPosition.partitionId
          : pickPartitionForLevel(current, targetLevel.id, targetCameraId)?.id ??
            pickPartitionForLevel(current, targetLevel.id, null)?.id ??
            sourceSlot.partitionId;

      const nextSlots = current.slots.map((slot) => ({ ...slot }));
      const movingSlot = nextSlots.find((slot) => slot.id === slotId);
      const occupyingSlot = nextSlots.find(
        (slot) =>
          slot.id !== slotId &&
          slot.levelId === targetLevel.id &&
          slot.row === targetRow &&
          slot.column === targetColumn,
      );

      if (!movingSlot) {
        return current;
      }

      if (occupyingSlot) {
        occupyingSlot.levelId = sourceSlot.levelId;
        occupyingSlot.row = sourceRow;
        occupyingSlot.column = sourceColumn;
      }

      movingSlot.levelId = targetLevel.id;
      movingSlot.row = targetRow;
      movingSlot.column = targetColumn;
      movingSlot.cameraId = targetCameraId;
      movingSlot.partitionId = targetPartitionId;

      return {
        ...current,
        slots: nextSlots,
      };
    });

    if (nextPosition.levelId) {
      setSelectedLevelId(nextPosition.levelId);
    }

    if (nextPosition.partitionId) {
      setSelectedPartitionId(nextPosition.partitionId);
    }

    if (nextPosition.cameraId) {
      setSelectedCameraId(nextPosition.cameraId);
      const nextFrame = editorLot?.frames.find((frame) => frame.cameraId === nextPosition.cameraId);
      if (nextFrame) {
        setCurrentFrameId((current) =>
          editorLot?.frames.some((frame) => frame.id === current && frame.cameraId === nextPosition.cameraId)
            ? current
            : nextFrame.id,
        );
      }
    }
  };

  const handleLevelGridChange = (
    dimension: "rows" | "columns",
    rawValue: string | number,
  ) => {
    if (!selectedPartition) {
      return;
    }

    const nextValue = sanitizePositiveInteger(rawValue);
    const nextRows = dimension === "rows" ? nextValue : selectedPartition.gridRows;
    const nextColumns = dimension === "columns" ? nextValue : selectedPartition.gridColumns;

    if (nextRows * nextColumns < selectedPartitionSlots.length) {
      setSaveMessage(
        `${selectedPartition.name || selectedLevel?.name || "Zone"} needs at least ${selectedPartitionSlots.length} cells for its current bays. Expand the other axis first.`,
      );
      return;
    }

    updatePartition(selectedPartition.id, (partition) => ({
      ...partition,
      gridRows: nextRows,
      gridColumns: nextColumns,
    }));
  };

  const handleApplyToLive = async () => {
    if (!selectedCamera || !editorLot || !selectedCameraId || !currentPreset) {
      return;
    }

    if (isCurrentPresetDirty) {
      const transition = await resolveDirtyTransition("applying this config to live");
      if (!transition.proceed) {
        return;
      }

      if (transition.savedPreset?.sourceVersion) {
        setPendingAction("apply");
        try {
          await client.configs.activate(selectedCameraId, transition.savedPreset.sourceVersion);
          const refreshedBundle = await client.configs.getEditorBundle(
            selectedCameraId,
            transition.savedPreset.sourceVersion,
          );
          const refreshedLot = buildEditableLotDefinition(
            refreshedBundle,
            liveSnapshot ?? null,
            selectedCameraId,
          );
          const presetRecord: PresetRecord = {
            id: `preset-${transition.savedPreset.sourceVersion}`,
            name: refreshedBundle.selected.presetName ?? transition.savedPreset.name,
            cameraId: selectedCameraId,
            lotDefinition: refreshedLot,
            savedLotDefinition: refreshedLot,
            sourceVersion: transition.savedPreset.sourceVersion,
            persisted: true,
            dirty: false,
          };
          setCameraBundles((current) => ({
            ...current,
            [selectedCameraId]: refreshedBundle,
          }));
          setCameraPresets((current) => ({
            ...current,
            [selectedCameraId]: upsertPreset(current[selectedCameraId] ?? [], presetRecord),
          }));
          setSelectedPresetId(presetRecord.id);
          hydrateEditorLot(refreshedLot, {
            presetKey: `${selectedCameraId}:${presetRecord.id}`,
            cameraId: selectedCameraId,
            resetView: true,
          });
          setSaveMessage(`Applied ${presetRecord.name} to live.`);
          await client.live.refresh();
        } catch {
          setSaveMessage("Applying this config failed. The sidecar must be running to activate it.");
        } finally {
          setPendingAction(null);
        }
        return;
      }
    }

    const presetVersion =
      cameraPresets[selectedCameraId]?.find((entry) => entry.id === currentPreset.id)?.sourceVersion ??
      currentPreset.sourceVersion;
    if (!presetVersion) {
      setSaveMessage("Save the current config before applying it to live.");
      return;
    }

    setPendingAction("apply");

    try {
      await client.configs.activate(selectedCameraId, presetVersion);
      const refreshedBundle = await client.configs.getEditorBundle(selectedCameraId, presetVersion);
      const refreshedLot = buildEditableLotDefinition(refreshedBundle, liveSnapshot ?? null, selectedCameraId);
      const presetRecord: PresetRecord = {
        id: `preset-${presetVersion}`,
        name: refreshedBundle.selected.presetName ?? currentPreset.name,
        cameraId: selectedCameraId,
        lotDefinition: refreshedLot,
        savedLotDefinition: refreshedLot,
        sourceVersion: presetVersion,
        persisted: true,
        dirty: false,
      };
      setCameraBundles((current) => ({
        ...current,
        [selectedCameraId]: refreshedBundle,
      }));
      setCameraPresets((current) => ({
        ...current,
        [selectedCameraId]: upsertPreset(
          current[selectedCameraId] ?? [],
          presetRecord,
        ),
      }));
      setSelectedPresetId(presetRecord.id);
      hydrateEditorLot(refreshedLot, {
        presetKey: `${selectedCameraId}:${presetRecord.id}`,
        cameraId: selectedCameraId,
        resetView: true,
      });
      setSaveMessage(`Applied ${presetRecord.name} to live.`);
      await client.live.refresh();
    } catch {
      setSaveMessage("Applying this config failed. The sidecar must be running to activate it.");
    } finally {
      setPendingAction(null);
    }
  };

  const handleCloseEditor = async () => {
    const transition = await resolveDirtyTransition("leaving the editor");
    if (!transition.proceed) {
      return;
    }

    onClose();
  };

  if (!editorLot || !selectedCameraId) {
    return (
      <main className="editor-shell">
        <header className="editor-topbar">
          <div className="editor-topbar__heading">
            <p className="editor-topbar__eyebrow">Lot authoring</p>
            <h1>Loading config</h1>
            <p>{saveMessage}</p>
          </div>
          <div className="editor-topbar__actions">
            <button type="button" className="text-button" onClick={() => void handleCloseEditor()}>
              Back to dashboard
            </button>
          </div>
        </header>
      </main>
    );
  }

  return (
    <main className="editor-shell">
      <header className="editor-topbar">
        <div className="editor-topbar__heading">
          <p className="editor-topbar__eyebrow">Lot authoring</p>
          <div className="editor-topbar__title-row">
            <h1>{editorLot.facilityName}</h1>
            <div className="editor-topbar__config-row">
              <label className="editor-topbar__name-field">
                <span>Config</span>
                <input
                  className="editor-topbar__name-input"
                  value={currentPreset?.name ?? ""}
                  onChange={(event) => handleConfigNameChange(event.target.value)}
                  placeholder="Untitled config"
                  disabled={!currentPreset || isSaving || isApplying}
                />
              </label>
              <span
                className={`editor-topbar__config-status editor-config-state editor-config-state--${currentPresetState.tone}`}
              >
                {currentPresetState.label}
              </span>
            </div>
          </div>
          <p className="editor-topbar__message">{saveMessage}</p>
        </div>

        <div className="editor-topbar__actions">
          <button type="button" className="text-button" onClick={() => void handleCloseEditor()}>
            Back to dashboard
          </button>
          <button
            type="button"
            className="top-bar__editor-button"
            onClick={() => void handleCreateBlankConfig()}
            disabled={isSaving || isApplying}
          >
            New blank config
          </button>
          <button
            type="button"
            className="top-bar__editor-button"
            onClick={() => void persistCurrentPreset()}
            disabled={!currentPreset || isSaving || isApplying || !isCurrentPresetDirty}
          >
            {isSaving ? "Saving..." : "Save config"}
          </button>
          <button
            type="button"
            className="top-bar__editor-button"
            onClick={() => void handleApplyToLive()}
            disabled={isSaving || isApplying || !currentPreset}
          >
            {isApplying ? "Applying..." : "Apply to live"}
          </button>
        </div>
      </header>

      <div className="editor-grid">
        <aside className="editor-sidebar panel">
          <section className="panel-section editor-panel-section--compact">
            <div className="section-heading">
              <h2>Lot summary</h2>
              <p>{editorLot.sourceLotKey}</p>
            </div>

            <dl className="metric-list editor-metric-list">
              <div>
                <dt>Matrix</dt>
                <dd>{summary.partitions}</dd>
              </div>
              <div>
                <dt>Plane</dt>
                <dd>{summary.totalLevels}</dd>
              </div>
              <div>
                <dt>Configs</dt>
                <dd>{summary.configs}</dd>
              </div>
              <div>
                <dt>Total bays</dt>
                <dd>{summary.totalSlots}</dd>
              </div>
              <div>
                <dt>Reserved defaults</dt>
                <dd>{summary.reservedDefaults}</dd>
              </div>
            </dl>

            <div className="editor-summary-strip">
              <span>{selectedCamera?.name ?? "No config loaded"}</span>
              <span>{currentFrame?.label ?? "No frame"}</span>
            </div>
          </section>

          <section className="panel-section editor-panel-section--compact editor-sidebar__planes">
            <div className="section-heading">
              <h2>Selected layout</h2>
              <div className="editor-heading-actions">
                <button type="button" className="text-button" onClick={handleAddZone} disabled={!selectedLevel}>
                  Add zone
                </button>
                <button type="button" className="text-button" onClick={handleAddLevel}>
                  Add plane
                </button>
              </div>
            </div>

            {selectedLevel ? (
              <div className="editor-form editor-form--compact">
                <div className="editor-form__row editor-form__row--layout">
                  <label className="editor-form__field">
                    <span>Active zone</span>
                    <select
                      value={selectedPartition?.id ?? ""}
                      onChange={(event) => handleSelectZone(event.target.value)}
                    >
                      {selectedLevelZones.map((zone) => (
                        <option key={zone.id} value={zone.id}>
                          {zone.name}
                        </option>
                      ))}
                    </select>
                  </label>

                  <label className="editor-form__field">
                    <span>Zone name</span>
                    <input
                      value={selectedPartition?.name ?? ""}
                      onChange={(event) => {
                        if (!selectedPartition) {
                          return;
                        }
                        updatePartition(selectedPartition.id, (partition) => ({
                          ...partition,
                          name: event.target.value,
                        }));
                      }}
                    />
                  </label>
                </div>

                <div className="editor-form__row editor-form__row--layout">
                  <label className="editor-form__field">
                    <span>Active plane</span>
                    <select
                      value={selectedLevel.id}
                      onChange={(event) => {
                        void handleSelectLevel(event.target.value);
                      }}
                    >
                      {levels.map((level) => (
                        <option key={level.id} value={level.id}>
                          {level.name}
                        </option>
                      ))}
                    </select>
                  </label>

                  <label className="editor-form__field">
                    <span>Plane name</span>
                    <input
                      value={selectedLevel.name}
                      onChange={(event) =>
                        updateLevel(selectedLevel.id, (level) => ({
                          ...level,
                          name: event.target.value,
                        }))
                      }
                    />
                  </label>
                </div>

                <div className="editor-form__row">
                  <label className="editor-form__field">
                    <span>Grid rows</span>
                    <div className="editor-stepper">
                      <button
                        type="button"
                        className="editor-stepper__button"
                        onClick={() => handleLevelGridChange("rows", (selectedPartition?.gridRows ?? 1) - 1)}
                        disabled={(selectedPartition?.gridRows ?? 1) <= 1}
                      >
                        -
                      </button>
                      <input
                        type="text"
                        inputMode="numeric"
                        value={selectedPartition?.gridRows ?? 1}
                        onChange={(event) => handleLevelGridChange("rows", event.target.value)}
                      />
                      <button
                        type="button"
                        className="editor-stepper__button"
                        onClick={() => handleLevelGridChange("rows", (selectedPartition?.gridRows ?? 1) + 1)}
                      >
                        +
                      </button>
                    </div>
                  </label>

                  <label className="editor-form__field">
                    <span>Grid columns</span>
                    <div className="editor-stepper">
                      <button
                        type="button"
                        className="editor-stepper__button"
                        onClick={() => handleLevelGridChange("columns", (selectedPartition?.gridColumns ?? 1) - 1)}
                        disabled={(selectedPartition?.gridColumns ?? 1) <= 1}
                      >
                        -
                      </button>
                      <input
                        type="text"
                        inputMode="numeric"
                        value={selectedPartition?.gridColumns ?? 1}
                        onChange={(event) => handleLevelGridChange("columns", event.target.value)}
                      />
                      <button
                        type="button"
                        className="editor-stepper__button"
                        onClick={() => handleLevelGridChange("columns", (selectedPartition?.gridColumns ?? 1) + 1)}
                      >
                        +
                      </button>
                    </div>
                  </label>
                </div>

                {selectedCamera ? (
                  <label className="editor-form__field">
                    <span>Projected set</span>
                    <select
                      value={selectedCamera.id}
                      onChange={(event) => {
                        void handleSelectCamera(event.target.value);
                      }}
                    >
                      {cameras.map((camera) => (
                        <option key={camera.id} value={camera.id}>
                          {camera.name}
                        </option>
                      ))}
                    </select>
                  </label>
                ) : null}

                <div className="editor-inline-actions editor-inline-actions--quad">
                  <button type="button" className="action-button" onClick={() => handleMoveLevel(-1)}>
                    Move up
                  </button>
                  <button type="button" className="action-button" onClick={() => handleMoveLevel(1)}>
                    Move down
                  </button>
                  <button
                    type="button"
                    className="action-button"
                    onClick={handleDeleteZone}
                    disabled={selectedLevelZones.length <= 1}
                  >
                    Delete zone
                  </button>
                  <button
                    type="button"
                    className="action-button"
                    onClick={handleDeleteLevel}
                    disabled={levels.length <= 1}
                  >
                    Delete plane
                  </button>
                </div>
              </div>
            ) : (
              <p className="detail-card__empty">Select or create a plane and zone to control this layout.</p>
            )}
          </section>
        </aside>

        <section className="editor-workspace">
          <div className="editor-workspace__column editor-workspace__column--left">
            <MatrixLayoutEditor
              lotDefinition={editorLot}
              selectedCameraId={selectedCamera?.id ?? selectedCameraId}
              selectedLevelId={selectedLevel?.id ?? null}
              selectedPartitionId={selectedPartition?.id ?? null}
              selectedSlotId={selectedSlotId}
              onSelectLevel={(levelId) => {
                void handleSelectLevel(levelId);
              }}
              onSelectPartition={(partitionId) => {
                handleSelectZone(partitionId);
              }}
              onSelectSlot={(slotId) => {
                void handleSelectSlot(slotId);
              }}
              onCreateSlot={(levelId, partitionId, row, column) =>
                handleCreateSlot(levelId, partitionId, row, column)
              }
            />

            <section className="panel editor-registry-panel">
              <div className="panel-section panel-section--grow editor-panel-section--compact editor-registry-panel__section">
                <div className="section-heading">
                  <h2>Bay registry</h2>
                  <p>
                    {selectedPartition
                      ? `${selectedPartitionCameraSlots.length} on ${selectedCamera?.name ?? "this camera"}`
                      : `${imageCanvasSlots.length} on ${selectedCamera?.name ?? "this camera"}`}
                  </p>
                </div>

                {selectedSlot ? (
                  <div className="editor-registry-panel__config">
                    <div className="editor-registry-panel__config-grid">
                      <label className="editor-form__field">
                        <span>Bay label</span>
                        <input
                          value={selectedSlot.label}
                          onChange={(event) =>
                            updateSlot(selectedSlot.id, (slot) => ({
                              ...slot,
                              label: event.target.value,
                            }))
                          }
                        />
                      </label>

                      <label className="editor-form__field">
                        <span>Bay id</span>
                        <input value={selectedSlot.id} disabled />
                      </label>

                      <label className="editor-form__field">
                        <span>Plane</span>
                        <select
                          value={selectedSlot.levelId}
                          onChange={(event) => {
                            const nextLevelId = event.target.value;
                            setSelectedLevelId(nextLevelId);
                            relocateSlot(selectedSlot.id, {
                              levelId: nextLevelId,
                              partitionId: pickPartitionForLevel(editorLot, nextLevelId, selectedSlot.cameraId)?.id,
                            });
                          }}
                        >
                          {levels.map((level) => (
                            <option key={level.id} value={level.id}>
                              {level.name}
                            </option>
                          ))}
                        </select>
                      </label>

                      <label className="editor-form__field">
                        <span>Zone</span>
                        <select
                          value={selectedSlot.partitionId}
                          onChange={(event) =>
                            relocateSlot(selectedSlot.id, { partitionId: event.target.value })
                          }
                        >
                          {partitions
                            .filter((partition) => partition.levelId === selectedSlot.levelId)
                            .map((zone) => (
                              <option key={zone.id} value={zone.id}>
                                {zone.name}
                              </option>
                            ))}
                        </select>
                      </label>

                      <label className="editor-form__field">
                        <span>Camera</span>
                        <select
                          value={selectedCamera?.id ?? ""}
                          onChange={(event) => {
                            void handleSelectCamera(event.target.value);
                          }}
                        >
                          {cameras.map((camera) => (
                            <option key={camera.id} value={camera.id}>
                              {camera.name}
                            </option>
                          ))}
                        </select>
                      </label>

                      <label className="editor-form__field">
                        <span>Row</span>
                        <select
                          value={String(selectedSlot.row)}
                          onChange={(event) => relocateSlot(selectedSlot.id, { row: Number(event.target.value) })}
                        >
                          {selectedSlotRowOptions.map((row) => (
                            <option key={row} value={row}>
                              R{row + 1}
                            </option>
                          ))}
                        </select>
                      </label>

                      <label className="editor-form__field">
                        <span>Column</span>
                        <select
                          value={String(selectedSlot.column)}
                          onChange={(event) =>
                            relocateSlot(selectedSlot.id, { column: Number(event.target.value) })
                          }
                        >
                          {selectedSlotColumnOptions.map((column) => (
                            <option key={column} value={column}>
                              C{column + 1}
                            </option>
                          ))}
                        </select>
                      </label>
                    </div>

                    <div className="editor-registry-panel__toggles">
                      <label className="editor-form__checkbox editor-form__checkbox--compact">
                        <input
                          type="checkbox"
                          checked={selectedSlot.evCapable}
                          onChange={(event) =>
                            updateSlot(selectedSlot.id, (slot) => ({
                              ...slot,
                              evCapable: event.target.checked,
                            }))
                          }
                        />
                        <span>EV capable</span>
                      </label>
                      <label className="editor-form__checkbox editor-form__checkbox--compact">
                        <input
                          type="checkbox"
                          checked={selectedSlot.reservedDefault === true}
                          onChange={(event) =>
                            updateSlot(selectedSlot.id, (slot) => ({
                              ...slot,
                              reservedDefault: event.target.checked,
                            }))
                          }
                        />
                        <span>Reserved default</span>
                      </label>
                      <div className="editor-registry-panel__tag">
                        <span>{selectedPartition?.name ?? selectedSlot.partitionId}</span>
                        <strong>{selectedSlotCamera?.name ?? selectedSlot.cameraId}</strong>
                      </div>
                    </div>

                    <div className="editor-inline-actions editor-inline-actions--quad">
                      <button type="button" className="action-button" onClick={handleAddSlot}>
                        Add bay
                      </button>
                      <button type="button" className="action-button" onClick={handleDuplicateSlot}>
                        Duplicate
                      </button>
                      <button type="button" className="action-button" onClick={handleDeleteSlot}>
                        Delete
                      </button>
                      <button
                        type="button"
                        className="action-button"
                        onClick={() => {
                          const obsCameraId = resolveObservationCameraId(
                            selectedSlot,
                            editorLot,
                            selectedCamera?.id ?? selectedCameraId ?? null,
                          );
                          if (selectedSlot.imagePolygonDefined === false && obsCameraId) {
                            void handleSelectSlot(selectedSlot.id);
                            return;
                          }

                          const hasCurrentRoi = selectedSlot.imagePolygonDefined !== false;
                          updateSlot(selectedSlot.id, (slot) => ({
                            ...slot,
                            imagePolygonDefined: !hasCurrentRoi,
                            imagePolygon: createRectanglePolygon(0.5, 0.5, 0.11, 0.16),
                          }));
                          setSaveMessage(
                            hasCurrentRoi
                              ? `Cleared the ROI for ${selectedSlot.label} on ${selectedCamera?.name ?? selectedSlot.cameraId}.`
                              : `Created a new ROI for ${selectedSlot.label} on ${selectedCamera?.name ?? selectedSlot.cameraId}.`,
                          );
                          if (!hasCurrentRoi) {
                            setIsPolygonEditing(true);
                          }
                        }}
                      >
                        {selectedSlot.imagePolygonDefined === false
                          ? resolveObservationCameraId(selectedSlot, editorLot, selectedCamera?.id ?? selectedCameraId ?? null)
                            ? `View ROI on ${resolveObservationCameraId(selectedSlot, editorLot, selectedCamera?.id ?? selectedCameraId ?? null)}`
                            : "Create ROI"
                          : "Clear ROI"}
                      </button>
                    </div>
                  </div>
                ) : (
                  <div className="editor-registry-panel__empty">
                    Pick a bay from the matrix to configure its plane, zone, camera, grid position, and flags.
                  </div>
                )}

                <div className="section-heading section-heading--inline">
                  <button type="button" className="text-button" onClick={handleAddSlot}>
                    Add bay
                  </button>
                  <span className="editor-inline-hint">Active zone register</span>
                </div>

                <div className="level-list editor-registry-panel__list">
                  {orderedLevelSlots.length > 0 ? (
                    orderedLevelSlots.map((slot) => {
                      const slotCamera = cameras.find((camera) => camera.id === slot.cameraId);
                      return (
                        <button
                          key={slot.id}
                          type="button"
                          className={`level-row ${selectedSlotId === slot.id ? "is-active" : ""}`}
                          onClick={() => handleSelectSlot(selectedSlotId === slot.id ? null : slot.id)}
                        >
                          <span className="level-row__name">{slot.label}</span>
                          <span className="level-row__stats">
                            <strong>{slot.id}</strong>
                            <span>{`R${slot.row + 1} C${slot.column + 1}${slot.evCapable ? " · EV" : ""}`}</span>
                            <span>{slotCamera?.name ?? slot.cameraId}</span>
                          </span>
                        </button>
                      );
                    })
                  ) : (
                    <p className="bay-registry__empty">
                      No ROIs mapped in the active zone for {selectedCamera?.name ?? "this camera"}. Select a bay from the matrix to create one.
                    </p>
                  )}
                </div>
              </div>
            </section>
          </div>

          <div className="editor-workspace__column editor-workspace__column--right">
            <EditablePolygonCanvas
              title="Image calibration"
              subtitle={
                isPolygonEditing
                  ? "Polygon editing active. Drag vertices or whole ROIs in this config."
                  : imageCanvasSlots.length > 0
                    ? "Navigation active. Drag to move around the frame and pinch to zoom."
                    : "This camera has no ROIs yet. Select a bay from the matrix to create one."
              }
              slots={imageCanvasSlots}
              selectedSlotId={selectedSlotId}
              backgroundImageUrl={imageFrameUrl}
              variant="image"
              zoom={imageZoom}
              viewResetKey={imageViewResetKey}
              interactionMode={isPolygonEditing ? "edit" : "navigate"}
              onZoomChange={handleZoomChange}
              controls={
                <div className="calibration-console">
                  <div className="calibration-console__cluster calibration-console__cluster--dense calibration-console__cluster--grid">
                    <span className="calibration-console__label">Camera</span>
                    <select
                      value={selectedCamera?.id ?? ""}
                      onChange={(event) => {
                        void handleSelectCamera(event.target.value);
                      }}
                      disabled={isSaving || isApplying}
                    >
                      {cameras.map((camera) => (
                        <option key={camera.id} value={camera.id}>
                          {camera.name}
                        </option>
                      ))}
                    </select>
                    <span className="calibration-console__label">Config</span>
                    <div className="calibration-console__current-set">
                      <span className="calibration-console__current-set-name">
                        {currentPreset?.name ?? "Untitled config"}
                      </span>
                      <span
                        className={`calibration-console__current-set-state editor-config-state editor-config-state--${currentPresetState.tone}`}
                      >
                        {currentPresetState.label}
                      </span>
                    </div>
                    <select
                      value=""
                      onChange={(event) => {
                        if (!event.target.value) {
                          return;
                        }
                        void handleSelectPreset(event.target.value);
                      }}
                      disabled={
                        isSaving ||
                        isApplying ||
                        currentCameraPresetRecords.filter((preset) => preset.id !== currentPreset?.id).length === 0
                      }
                    >
                      <option value="">Switch config</option>
                      {currentCameraPresetRecords
                        .filter((preset) => preset.id !== currentPreset?.id)
                        .map((preset) => (
                          <option key={preset.id} value={preset.id}>
                            {formatPresetOptionLabel(
                              preset,
                              describePresetState(
                                preset,
                                preset.dirty,
                                currentActiveVersion,
                              ),
                            )}
                          </option>
                        ))}
                    </select>
                    <button
                      type="button"
                      className="action-button"
                      onClick={() => void handleCloneCameraSet()}
                      disabled={!selectedCamera || isSaving || isApplying}
                    >
                      Clone
                    </button>
                    <button
                      type="button"
                      className="action-button"
                      onClick={() => void handleDeleteCameraSet()}
                      disabled={currentCameraPresetRecords.length <= 1 || isSaving || isApplying}
                    >
                      Delete
                    </button>
                  </div>

                  <div className="calibration-console__cluster calibration-console__cluster--dense calibration-console__cluster--frame">
                    <button
                      type="button"
                      className="action-button"
                      onClick={() => handleStepFrame(-1)}
                      disabled={!currentFrame || currentFrame.id === currentCameraFrames[0]?.id}
                      aria-label="Previous frame"
                    >
                      ←
                    </button>
                    <button
                      type="button"
                      className="action-button"
                      onClick={() => handleStepFrame(1)}
                      disabled={!currentFrame || currentFrame.id === currentCameraFrames.at(-1)?.id}
                      aria-label="Next frame"
                    >
                      →
                    </button>
                    <button
                      type="button"
                      className={`action-button ${isPolygonEditing ? "is-active" : ""}`}
                      aria-pressed={isPolygonEditing}
                      onClick={() => setIsPolygonEditing((current) => !current)}
                      disabled={isSaving || isApplying}
                    >
                      Edit polygons
                    </button>
                    <button
                      type="button"
                      className="action-button"
                      onClick={resetImageView}
                      aria-label="Reset image view"
                    >
                      Reset view
                    </button>
                  </div>
                </div>
              }
              onSelectSlot={(slotId) => {
                void handleSelectSlot(slotId);
              }}
              onMoveVertex={(slotId, vertexIndex, nextPoint) =>
                updateSlot(slotId, (slot) => ({
                  ...slot,
                  imagePolygonDefined: true,
                  imagePolygon: setPolygonVertex(slot.imagePolygon, vertexIndex, nextPoint),
                }))
              }
              onTranslatePolygon={(slotId, deltaX, deltaY) =>
                updateSlot(slotId, (slot) => ({
                  ...slot,
                  imagePolygonDefined: true,
                  imagePolygon: translatePolygon(slot.imagePolygon, deltaX, deltaY),
                }))
              }
            />
          </div>
        </section>
      </div>
    </main>
  );
}

function upsertPreset(records: PresetRecord[], preset: PresetRecord) {
  const next = [...records.filter((entry) => entry.id !== preset.id), preset];
  next.sort((left, right) => left.id.localeCompare(right.id));
  return next;
}

function normalizePresetName(name: string | null | undefined, fallback: string) {
  const trimmed = name?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : fallback;
}

function describePresetState(
  preset: PresetRecord | null,
  isDirty: boolean,
  activeVersion: number | null,
): { label: string; tone: "dirty" | "draft" | "saved" | "live" } {
  if (!preset) {
    return {
      label: "Local draft",
      tone: "draft",
    };
  }

  if (isDirty) {
    return {
      label: preset.sourceVersion ? `v${preset.sourceVersion} · unsaved` : "New · unsaved",
      tone: "dirty",
    };
  }

  if (!preset.persisted || preset.sourceVersion === null) {
    return {
      label: "Local draft",
      tone: "draft",
    };
  }

  if (activeVersion !== null && preset.sourceVersion === activeVersion) {
    return {
      label: `v${preset.sourceVersion} · live`,
      tone: "live",
    };
  }

  return {
    label: `v${preset.sourceVersion} · saved`,
    tone: "saved",
  };
}

function formatPresetOptionLabel(
  preset: PresetRecord,
  state: { label: string },
) {
  return `${preset.name} (${state.label})`;
}

function collectPresetCameraIds(
  lotDefinition: LotDefinition | null,
  knownCameraIds: string[],
  selectedCameraId: string | null,
) {
  return Array.from(
    new Set(
      [
        ...(lotDefinition?.cameras ?? []).map((camera) => camera.id),
        ...knownCameraIds,
        selectedCameraId ?? undefined,
      ].filter((value): value is string => Boolean(value)),
    ),
  );
}

function replacePresetAcrossCameras(
  recordsByCamera: Record<string, PresetRecord[]>,
  cameraIds: string[],
  preset: PresetRecord,
  previousPresetId?: string | null,
  sourceCameraId?: string | null,
) {
  const next = { ...recordsByCamera };

  for (const cameraId of cameraIds) {
    const filtered = (next[cameraId] ?? []).filter(
      (entry) => entry.id !== preset.id && entry.id !== previousPresetId,
    );
    // Null out lotDefinition for non-source cameras so that switching
    // cameras forces a fresh fetch/re-hydration instead of showing data
    // hydrated for the wrong camera's observation polygons.
    const isSource = !sourceCameraId || cameraId === sourceCameraId;
    next[cameraId] = upsertPreset(filtered, {
      ...preset,
      cameraId,
      lotDefinition: isSource ? preset.lotDefinition : null,
      savedLotDefinition: isSource ? preset.savedLotDefinition : null,
    });
  }

  return next;
}

function findNextAvailableCell(partitionId: string, lotDefinition: LotDefinition) {
  const partition = lotDefinition.partitions.find((entry) => entry.id === partitionId);
  const level = partition ? getLotLevels(lotDefinition).find((entry) => entry.id === partition.levelId) ?? null : null;
  const slots = lotDefinition.slots.filter((slot) => slot.partitionId === partitionId);
  const occupied = new Set(slots.map((slot) => `${slot.row}:${slot.column}`));

  if (!partition && !level) {
    return null;
  }

  const rows = Math.max(partition?.gridRows ?? level?.gridRows ?? 1, 1);
  const columns = Math.max(partition?.gridColumns ?? level?.gridColumns ?? 1, 1);

  for (let row = 0; row < rows; row += 1) {
    for (let column = 0; column < columns; column += 1) {
      if (!occupied.has(`${row}:${column}`)) {
        return { row, column };
      }
    }
  }

  return null;
}

function pickPartitionForLevel(
  lotDefinition: LotDefinition | null,
  levelId: string,
  cameraId: string | null,
) {
  if (!lotDefinition) {
    return null;
  }

  const partitions = lotDefinition.partitions
    .filter((partition) => partition.levelId === levelId)
    .sort((left, right) => left.order - right.order || left.name.localeCompare(right.name));

  if (partitions.length === 0) {
    return null;
  }

  if (cameraId) {
    const cameraPartition =
      partitions.find((partition) => partition.ownerCameraIds.includes(cameraId)) ??
      partitions.find((partition) =>
        lotDefinition.slots.some((slot) => slot.partitionId === partition.id && slot.cameraId === cameraId),
      );

    if (cameraPartition) {
      return cameraPartition;
    }
  }

  return partitions[0];
}

function createPartitionDefinition(
  level: LotLevelDefinition,
  index: number,
  ownerCameraIds: string[],
): LayoutPartitionDefinition {
  return {
    id: `${level.id}-PART-${String(index + 1).padStart(2, "0")}`,
    name: `Zone ${String(index + 1).padStart(2, "0")}`,
    levelId: level.id,
    order: index,
    gridRows: Math.max(level.gridRows, 1),
    gridColumns: Math.max(level.gridColumns, 1),
    ownerCameraIds,
    layoutPolygon: null,
  };
}

function resolveEditorFrameUrl(
  frameId: string,
  imagePath: string | null | undefined,
  cameraId: string | null,
) {
  if (imagePath) {
    const trimmed = imagePath.trim();
    const isApiPath = trimmed.startsWith("/api/");
    const isBrowserUrl =
      trimmed.startsWith("http://") ||
      trimmed.startsWith("https://") ||
      trimmed.startsWith("data:") ||
      trimmed.startsWith("blob:");
    const looksLikeLocalAbsolutePath = trimmed.startsWith("/Users/") || trimmed.startsWith("C:\\") || trimmed.startsWith("\\\\");

    if ((isApiPath || isBrowserUrl) && !looksLikeLocalAbsolutePath) {
      return trimmed;
    }
  }

  const encodedFrameId = encodeURIComponent(frameId);
  const encodedCameraId = cameraId ? `?cameraId=${encodeURIComponent(cameraId)}` : "";
  return `/api/live/frame/${encodedFrameId}${encodedCameraId}`;
}

function getNextSlotNumber(lotDefinition: LotDefinition) {
  const numbers = lotDefinition.slots.flatMap((slot) => {
    const idMatch = slot.id.match(/(\d+)/);
    const labelMatch = slot.label.match(/(\d+)/);

    return [idMatch?.[1], labelMatch?.[1]]
      .filter((value): value is string => Boolean(value))
      .map((value) => Number(value));
  });

  return Math.max(0, ...numbers) + 1;
}

function formatSlotId(index: number) {
  return `B${String(index).padStart(2, "0")}`;
}

function formatSlotLabel(index: number) {
  return `Bay ${String(index).padStart(2, "0")}`;
}

/**
 * When a bay has no observation polygon on the current camera, find the
 * camera that DOES have one so the frame can switch to show it.
 */
function resolveObservationCameraId(
  slot: LotSlotDefinition,
  lotDefinition: LotDefinition | null,
  currentCameraId: string | null,
): string | null {
  if (!lotDefinition) {
    return null;
  }

  const match = lotDefinition.observationPolygons.find(
    (polygon) => polygon.canonicalBayId === slot.id && polygon.cameraId !== currentCameraId,
  );
  if (match) {
    return match.cameraId;
  }

  // Fallback: check slot ownership metadata
  const candidates = Array.from(
    new Set([slot.cameraId, ...(slot.ownerCameraIds ?? [])].filter(Boolean)),
  );
  return candidates.find((cameraId) => cameraId !== currentCameraId) ?? null;
}

function clampGridIndex(value: number, size: number) {
  return Math.min(Math.max(0, value), Math.max(size - 1, 0));
}

function sanitizePositiveInteger(rawValue: string | number) {
  const value =
    typeof rawValue === "number"
      ? rawValue
      : Number.parseInt(String(rawValue).replace(/[^\d]/g, ""), 10);

  return Math.max(1, Number.isFinite(value) ? value : 1);
}

function clampZoom(value: number) {
  return Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, Number(value.toFixed(2))));
}
