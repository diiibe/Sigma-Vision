import numpy as np
from unittest.mock import patch, MagicMock
from backend.eventdetect.model import VideoMAEDetector, EVENT_FAMILIES


def test_event_families_mapping():
    assert EVENT_FAMILIES["Fighting_Videos"] == "physical_conflict"
    assert EVENT_FAMILIES["RoadAccidents_Videos"] == "accident_related"
    assert EVENT_FAMILIES["Normal_Videos_event"] == "normal"


def test_detector_init():
    detector = VideoMAEDetector(model_name="test-model")
    assert detector.model_name == "test-model"
    assert detector._model is None
    assert detector._processor is None


def test_detector_predict_shape():
    detector = VideoMAEDetector()

    mock_processor = MagicMock()
    mock_processor.return_value = {"pixel_values": MagicMock()}

    mock_logits = MagicMock()
    mock_logits.softmax.return_value = MagicMock()
    mock_logits.softmax.return_value.squeeze.return_value.cpu.return_value.numpy.return_value = (
        np.array([0.05] * 13 + [0.35])
    )

    mock_output = MagicMock()
    mock_output.logits = mock_logits

    mock_model = MagicMock()
    mock_model.return_value = mock_output
    mock_model.config.id2label = {i: f"class_{i}" for i in range(14)}
    mock_model.config.id2label[7] = "Normal_Videos_event"

    detector._model = mock_model
    detector._processor = mock_processor
    detector._labels = list(mock_model.config.id2label.values())
    detector._normal_label = "Normal_Videos_event"
    detector._device = "cpu"

    frames = [np.zeros((224, 224, 3), dtype=np.uint8) for _ in range(16)]
    result = detector.predict(frames)

    assert isinstance(result, dict)
    assert len(result) == 14
    assert all(isinstance(v, float) for v in result.values())
