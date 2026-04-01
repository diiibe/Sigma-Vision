from __future__ import annotations

import torch

from torch import Tensor
from torch.nn.functional import grid_sample


@torch.jit.script
def linspace(start: Tensor, stop: Tensor, num: int):
    steps = torch.arange(num, dtype=torch.float32, device=start.device) / (num - 1)

    for _ in range(start.ndim):
        steps = steps.unsqueeze(-1)

    return start[None] + steps * (stop - start)[None]


@torch.jit.script
def roi_grid(rois: Tensor, size: int = 3):
    idx_edge_1 = linspace(start=rois[:, 1], stop=rois[:, 2], num=size)
    idx_edge_2 = linspace(start=rois[:, 0], stop=rois[:, 3], num=size)
    rois_interpolated = linspace(start=idx_edge_1, stop=idx_edge_2, num=size)
    return rois_interpolated.permute([2, 1, 0, 3])


@torch.jit.script
def roi_pool_square(tensor: Tensor, rois: Tensor, size: int = 3):
    w = torch.amax(rois[:, :, 0], 1) - torch.amin(rois[:, :, 0], 1)
    h = torch.amax(rois[:, :, 1], 1) - torch.amin(rois[:, :, 1], 1)
    c = torch.mean(rois, 1, keepdim=True).repeat(1, 4, 1)
    c[:, 0, 0] += w / 2
    c[:, 0, 1] += h / 2
    c[:, 1, 0] -= w / 2
    c[:, 1, 1] += h / 2
    c[:, 2, 0] -= w / 2
    c[:, 2, 1] -= h / 2
    c[:, 3, 0] += w / 2
    c[:, 3, 1] -= h / 2
    rois_interpolated = (roi_grid(c, size) * 2) - 1
    return torch.stack(
        [grid_sample(tensor[None], roi[None], align_corners=True)[0] for roi in rois_interpolated]
    )


@torch.jit.script
def roi_pool_qdrl(tensor: Tensor, rois: Tensor, size: int = 3):
    rois_interpolated = (roi_grid(rois, size) * 2) - 1
    return torch.stack(
        [grid_sample(tensor[None], roi[None], align_corners=True)[0] for roi in rois_interpolated]
    )


@torch.jit.script
def roi_pool(tensor: Tensor, rois: Tensor, size: int = 3, pooling_type: str = "square"):
    if pooling_type == "square":
        return roi_pool_square(tensor, rois, size)
    if pooling_type == "qdrl":
        return roi_pool_qdrl(tensor, rois, size)
    raise RuntimeError(f"unknown pooling method {pooling_type}")
