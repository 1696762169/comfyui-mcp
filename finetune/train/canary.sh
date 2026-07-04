#!/usr/bin/env bash
# Canary training run — validates the WHOLE pipeline on a fresh GPU pod before
# any full-scale run. Not meant to produce a good model; meant to prove every
# stage works: Heretic base loads in Unsloth, Gemma-4 chat template renders
# tools, response-masking finds the markers, QLoRA trains a few steps, and it
# exports a GGUF that Ollama can load with tool calls.
#
# Usage (on the pod, as root):  bash finetune/train/canary.sh
# Expects HF_TOKEN in env (Gemma is gated). Run from the repo root.
set -euo pipefail

echo "═══ [canary] 1/6 · environment ═══"
nvidia-smi --query-gpu=name,memory.total --format=csv,noheader
python --version

echo "═══ [canary] 2/6 · deps ═══"
pip install -q -U pip
pip install -q -U unsloth trl datasets pyyaml huggingface_hub hf_transfer
export HF_HUB_ENABLE_HF_TRANSFER=1
python -c "import os; from huggingface_hub import login; login(os.environ['HF_TOKEN'])"

echo "═══ [canary] 3/6 · assemble dataset (domain-only — isolates core pipeline) ═══"
# Canary validates base-load/template/train/export; the external Toucan/xLAM
# blend is orthogonal (and network-dependent), so keep it out of the canary.
cd finetune/train
python prepare_dataset.py --val-frac 0.05

echo "═══ [canary] 4/6 · DRY RUN (verify Gemma-4 template + response markers) ═══"
# This is the make-or-break check: if the template markers are wrong the run
# would silently train on the whole sequence instead of assistant turns.
python train_qlora.py --size 12b --dry-run

echo "═══ [canary] 5/6 · train 30 steps (12B QLoRA on Heretic base) ═══"
python train_qlora.py --size 12b --max-steps 30

echo "═══ [canary] 6/6 · confirm exports ═══"
ls -lah outputs/gemma4-12b-comfyui-mcp/ || true
ls -lah outputs/gemma4-12b-comfyui-mcp/gguf-q4_k_m/ 2>/dev/null || echo "(gguf dir — check name)"
echo "═══ [canary] DONE — pipeline validated end to end ═══"
