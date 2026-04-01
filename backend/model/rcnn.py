from __future__ import annotations

from torch import nn

from . import pooling


try:
    from torchvision.models import resnet50
    from torchvision.ops.misc import FrozenBatchNorm2d
except ImportError as exc:  # pragma: no cover - exercised via predictor fallback.
    resnet50 = None
    FrozenBatchNorm2d = None
    IMPORT_ERROR = exc
else:
    IMPORT_ERROR = None


class RCNN(nn.Module):
    def __init__(self, roi_res: int = 128, pooling_type: str = "square"):
        if resnet50 is None or FrozenBatchNorm2d is None:
            raise RuntimeError("torchvision is required to build the RCNN model") from IMPORT_ERROR

        super().__init__()
        self.backbone = resnet50(weights=None, norm_layer=FrozenBatchNorm2d)
        self.backbone.fc = nn.Linear(in_features=2048, out_features=2)

        layers_to_train = ["layer4", "layer3", "layer2"]
        for name, parameter in self.backbone.named_parameters():
            if all(not name.startswith(layer) for layer in layers_to_train):
                parameter.requires_grad_(False)

        self.roi_res = roi_res
        self.pooling_type = pooling_type

    def forward(self, image, rois):
        warps = pooling.roi_pool(image, rois, self.roi_res, self.pooling_type)
        return self.backbone(warps)
