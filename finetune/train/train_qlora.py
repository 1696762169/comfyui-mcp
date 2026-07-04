#!/usr/bin/env python3
"""QLoRA fine-tune of huihui-ai's abliterated Gemma 4 into a ComfyUI-MCP expert.

Run on the training pod (see finetune/README.md for the RunPod recipe):
  python train_qlora.py [--config config.yaml] [--dry-run]

Design notes:
- The base is the ABLITERATED checkpoint loaded directly from HF — abliteration
  is baked into the weights (refusal direction orthogonalized out), so QLoRA on
  top preserves it. We do NOT re-apply any abliteration step here.
- Domain records reference the shared comfyui tool list; it is injected via
  apply_chat_template(tools=...) so the model trains against the EXACT schemas
  it will see at inference. Never hand-roll the template — Gemma 4's tool-call
  tokens (<|tool_call>...<tool_call|>) come from the tokenizer.
- Loss is masked to assistant turns via Unsloth's train_on_responses_only with
  the turn markers from config.yaml (verify them on-pod with --dry-run first).
"""
from __future__ import annotations

import argparse
import json
from pathlib import Path

import yaml

HERE = Path(__file__).resolve().parent


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--config", default=str(HERE / "config.yaml"))
    ap.add_argument("--size", default=None, help="size-ladder key (e2b/e4b/12b/31b); default: config 'size'")
    ap.add_argument("--dry-run", action="store_true", help="render 2 samples and exit (verify template + masking)")
    args = ap.parse_args()
    cfg = yaml.safe_load(Path(args.config).read_text(encoding="utf-8"))

    # Resolve the size-ladder rung: the same dataset trains onto every Gemma 4
    # size (e2b→31b) so users pick by VRAM budget. --size overrides config 'size'.
    size = args.size or cfg.get("size")
    rung = (cfg.get("size_ladder") or {}).get(size) if size else None
    if rung:
        cfg["base_model"] = rung["base_model"]
        cfg["max_seq_length"] = rung.get("max_seq_length", cfg["max_seq_length"])
        cfg["output_dir"] = f"outputs/gemma4-{size}-comfyui-mcp"
        print(f"[train] size={size} base={cfg['base_model']} seq_len={cfg['max_seq_length']}")

    from unsloth import FastLanguageModel  # import first: patches transformers

    from datasets import load_dataset
    from trl import SFTConfig, SFTTrainer
    from unsloth.chat_templates import train_on_responses_only

    model, tokenizer = FastLanguageModel.from_pretrained(
        model_name=cfg["base_model"],
        max_seq_length=cfg["max_seq_length"],
        load_in_4bit=cfg["load_in_4bit"],
    )
    model = FastLanguageModel.get_peft_model(
        model,
        r=cfg["lora"]["r"],
        lora_alpha=cfg["lora"]["alpha"],
        lora_dropout=cfg["lora"]["dropout"],
        target_modules=cfg["lora"]["target_modules"],
        use_gradient_checkpointing="unsloth",
        random_state=cfg["training"]["seed"],
    )

    tools_full = json.loads((HERE / cfg["data"]["tools_file"]).read_text(encoding="utf-8"))
    comfyui_tools = [
        {"type": "function", "function": {"name": t["name"], "description": t["description"], "parameters": t["inputSchema"]}}
        for t in tools_full["tools"]
    ]

    def render(example: dict) -> dict:
        tools = comfyui_tools if example["tools"] == "comfyui" else example.get("inline_tools") or None
        text = tokenizer.apply_chat_template(example["messages"], tools=tools, tokenize=False)
        return {"text": text}

    data_files = {
        "train": str((HERE / cfg["data"]["train_file"]).resolve()),
        "val": str((HERE / cfg["data"]["val_file"]).resolve()),
    }
    ds = load_dataset("json", data_files=data_files)
    ds = ds.map(render, remove_columns=[c for c in ds["train"].column_names if c != "text"])

    if args.dry_run:
        for i in range(2):
            sample = ds["train"][i]["text"]
            print(f"\n===== SAMPLE {i} ({len(sample)} chars) =====")
            print(sample[:2000])
            print("..." if len(sample) > 2000 else "")
            for marker in (cfg["template"]["instruction_part"], cfg["template"]["response_part"]):
                print(f"marker {marker!r}: {'FOUND' if marker in sample else 'MISSING — fix config.yaml template markers'}")
        return

    tr = cfg["training"]
    trainer = SFTTrainer(
        model=model,
        tokenizer=tokenizer,
        train_dataset=ds["train"],
        eval_dataset=ds["val"],
        args=SFTConfig(
            output_dir=cfg["output_dir"],
            dataset_text_field="text",
            max_seq_length=cfg["max_seq_length"],
            num_train_epochs=tr["num_train_epochs"],
            per_device_train_batch_size=tr["per_device_train_batch_size"],
            gradient_accumulation_steps=tr["gradient_accumulation_steps"],
            learning_rate=tr["learning_rate"],
            lr_scheduler_type=tr["lr_scheduler_type"],
            warmup_ratio=tr["warmup_ratio"],
            weight_decay=tr["weight_decay"],
            optim=tr["optim"],
            logging_steps=tr["logging_steps"],
            save_steps=tr["save_steps"],
            seed=tr["seed"],
            report_to="none",
        ),
    )
    trainer = train_on_responses_only(
        trainer,
        instruction_part=cfg["template"]["instruction_part"],
        response_part=cfg["template"]["response_part"],
    )
    trainer.train()

    out = Path(cfg["output_dir"])
    model.save_pretrained_merged(str(out / "merged-16bit"), tokenizer, save_method="merged_16bit")
    for quant in cfg["export"]["gguf_quants"]:
        model.save_pretrained_gguf(str(out / f"gguf-{quant}"), tokenizer, quantization_method=quant)
    if cfg["export"]["hf_repo"]:
        model.push_to_hub_merged(cfg["export"]["hf_repo"], tokenizer, save_method="merged_16bit")
    print(f"[train] done → {out}")


if __name__ == "__main__":
    main()
