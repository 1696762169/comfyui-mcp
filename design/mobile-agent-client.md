# Agentic ComfyUI — mobile / remote agent (vision doc)

> Living doc. Casual "run it by a smart friend" framing at the top; concrete
> architecture + open questions below. Not building yet — shaping it first.

---

## The pitch

Okay, want your honest read on something. Context first: the thing I've been
building (**comfyui-mcp** + the **Agent Panel**) puts an AI agent *inside*
ComfyUI — it drives the node canvas at full parity, you just tell it what you
want and it wires the graph, picks models, runs it. Runs on your own
Claude/ChatGPT sub or a local model, connects to your own GPU (home rig or a
RunPod pod). No cloud middleman, no per-image fees. That part works today.

The idea I want to gut-check is the **next** thing, once the core is solid
enough to lean on: **a purely agent-driven way to make things from your phone —
backed by an agent that runs on your own machine.**

The bet is basically: *most people should never see a node graph.* ComfyUI is
unbelievably powerful and unbelievably hostile to newcomers, and on a phone a
canvas is a non-starter anyway. So instead of shrinking the graph onto a screen,
I want to invert it — **you chat, the agent builds.** The graph still exists
under the hood; it just isn't the interface.

Where it's not *pure* chat: closer to **Keynote / Google-Sketch-style keyed
blocks** than a chat app. You drop blocks — "input image," "style," "a character
I keep reusing," "this LoRA," "output as video" — and those are the handful of
things worth touching directly, with real knobs. Everything *between* the blocks
(the wiring, samplers, the 40 nodes it takes to make that work) the agent handles
from conversation. Blocks are the **nouns you care about**; chat is how you
compose and adjust them.

## How it actually runs (the part that changed)

Local-first is the whole personality, so the delivery model matters as much as
the UI:

- **You download a desktop app that runs on your machine — think how you run
  Ollama.** It's the *agent host*: it owns the agent loop, talks to your local
  ComfyUI, and uses your LLM (a local model, or your Claude / ChatGPT / Gemini
  login). It's always-on and quiet, like a daemon.
- **The desktop app exports a secure connection out — Tailscale / cloudflared
  style.** No port-forwarding, no router surgery. It stands up an encrypted
  tunnel so a remote client (your phone) can reach the agent that's running at
  home, without exposing anything to the open internet.
- **Pairing is a "remote control" flow — basically Claude's `/remote-control`,
  but the entry point is a "Remote control" button right in the
  comfyui-mcp-panel.** You hit it, it hands you a pairing token / QR, your phone
  scans it, and now the phone drives the *same* agent + session. (We already do
  a chunk of this — the panel stands up a secure cloudflared tunnel to a pod
  today with zero URL-pasting.)
- **Token-based, not account-required.** It *could* be account-linked, but
  people who pick a local-first tool are picking it for privacy — so the default
  is **token pairing, and everything stays inside your own network.** No
  telemetry hop, no "sign in to use your own GPU." (Account linking stays an
  optional convenience, never a requirement.)

So the phone isn't doing inference or holding secrets — it's a **thin remote
control** for a brain + a GPU you already own. The desktop host is the product;
the phone (and eventually a web client) is a window into it.

## Two UIs, one spec (the part I'm most excited about)

The desktop panel and the mobile app aren't two products — they're two windows on
the same thing. Both **generate and consume the exact same workflow spec**, so
anything built in one opens cleanly in the other. Start a piece on the couch on
your phone, finish it at your desk in the full canvas; or build it on desktop and
hand it to a friend who opens it on their phone. The spec is the contract; the UI
is just how you touch it. (It's also what makes "no canvas on mobile" *safe* — the
graph is never lost, it's just not *shown*.)

## Depth on demand (Apps → blocks → dials → graph)

Sean (from the Discord) nailed a piece of this: ComfyUI already ships an **Apps**
feature (beta) that strips a workflow down to just its exposed parameters and
hides the nodes. That's the shallow end — and it should be a *first-class surface*,
not something we reinvent. So the app has **depth on demand**; you choose how deep
you go, and it's always the same piece underneath:

1. **Library → Apps (run).** A **Library tab** of ready-to-run "apps" — load one,
   it's a clean form with the parameters baked in, hit go. Zero graph, zero setup.
   This is where most sessions live.
2. **Blocks (compose).** The keyed-block view — the nouns of the workflow as cards
   you rearrange, swap, and rewire. Chat handles the in-between.
3. **Dials (tune).** **Expand a block** to reveal *all* its knobs — every widget
   the node exposes, surfaced through the same **widget-promotion** path ComfyUI
   already uses. "Give me more control" is one tap deeper, not a different app.
4. **The whole graph (build).** Drop all the way to real node editing — manually
   *or* agentically. Nothing is hidden; it's just not in your face until you ask.

Same workflow spec at every level — you're not switching tools, just zooming in.
App today, dials tomorrow, full rewire next week, all on the same piece.

## Subgraphs + a stocked library

**Subgraphs behave like blocks** — a subgraph is just a collapsed tower you can
drop in, run, or **expand to its internals and dials** like any other block. That
makes reuse natural: build something good once, collapse it, reuse it everywhere
(and it expands with the same App → dials → graph depth).

And the Library isn't empty on day one — **we ship with a starter set:**

- **Base subgraphs** — the common pipelines (txt2img, img2img, upscale, a video
  pass…) so a fresh install is useful on minute one.
- **Utility subgraphs** — the quality-of-life ones that just make it better (smart
  resolution / aspect handling, prompt scaffolding, a "save + preview" tail,
  model-swap adapters…).

So the Library ships stocked with apps *and* the building blocks to remix them.

## CivitAI, first-class

Models and prompts are half the creative act, so CivitAI isn't a bolt-on — it's
built in:

- **Browse & search** models right in the app (checkpoints, LoRAs, VAEs…), view
  examples, and **copy prompts** straight off an image you like.
- **Download to your GPU with a tap** — and here's the Amazon bit: **add things to
  a cart.** Queue a checkpoint + three LoRAs + an upscaler, hit go, and they land
  on your rig (fast, via the same aria2 path the pods already use).
- The **agent self-heals** around it: a workflow needs a model you don't have? It
  finds it on CivitAI/HuggingFace, downloads it, wires it, and retries — no "node's
  red, good luck." (This already works in the panel today; mobile inherits it.)

## What it feels like on the phone

- **Swipe between trees like a Trello board.** Each workflow (or branch) is a
  card/lane; you flick sideways between them instead of pinch-zooming a canvas.
- **Connecting nodes snaps like Lego.** Drag two blocks together and the ports line
  up and click — compatible connections align and lock, incompatible ones won't, so
  you can't wire garbage. Towers of blocks, not a spaghetti graph.
- **You watch it flow.** As it generates, the page scrolls through the pipeline and
  **the output comes to you** — previews stream in, the result lands at the bottom
  where your thumb is. Generation is something you *watch happen*, not a spinner you
  stare at.

## Client: Flutter

Leaning **Flutter** for the client — I've shipped Flutter apps before, it's one
codebase for iOS/Android (and desktop/web later, which plays nicely with
"two UIs, one spec"), and the block / flow / port-snapping interactions are exactly
the kind of custom-canvas work Flutter is good at.

## Scope / phases

- **v1 — local GPU only.** Desktop host on your machine, your local ComfyUI,
  your local or logged-in LLM, phone pairs over the secure tunnel. Get *this*
  bulletproof first.
- **Later — RunPod (and cloud GPUs).** For a pod we'd set up an **SSH tunnel +
  helper scripts** to facilitate the annoying parts: logging into
  Claude / Gemini / Codex on the pod, or standing up Ollama directly on the pod.
  Deliberately **not** in the first release — local-GPU-to-start keeps the
  surface small and the "it just works" bar reachable.

## Where I actually want a gut-check

1. **Is "no canvas" a feature or a trap?** Newcomers probably love it; power
   users will scream for the graph. Do I need an escape hatch to the real
   thing, or does having one poison the simplicity?
2. **The blocks-vs-chat line.** What genuinely deserves a physical knob on a
   phone vs. "just tell it"? Pure chat for *everything* gets maddening when you
   only want to nudge one number.
3. **The waiting problem.** Generation takes 20s–minutes. Dead time kills phone
   apps. Background + push when done? Live preview streaming? Should it feel like
   "commission a thing and get pinged" more than "tap and stare"?
4. **The honest wedge.** What stops this from being "the web panel in a mobile
   browser"? Is the keyed-block model *actually* different enough to matter, or
   am I in love with a UI idea a responsive web page 80% solves?
5. **Pairing without a config nightmare.** Desktop host + secure tunnel + token
   is the plan — but how close to "tap the button, scan the code, done" does it
   have to be before normal people don't bounce?
6. **Who's it for?** The person who finds ComfyUI terrifying but wants that
   quality, vs. existing ComfyUI users who want a remote for their rig — pretty
   different products.
7. **Is "two UIs, one spec" a real draw or a nice-to-have?** I think the
   phone↔desktop handoff is a killer demo — but do people actually work that way,
   or do they live in one and never cross over?
8. **CivitAI as a "cart."** Is one-tap browse→cart→download→auto-wire the thing
   that makes it feel magic, or a rabbit hole? And are there ToS / licensing
   edges to programmatic model download I should design around up front?
9. **Lego-snap ports on a touchscreen.** Does "compatible ports align and lock"
   actually feel good with a thumb, or is node-wiring on a phone always going to
   be the part people avoid (and lean fully on chat for)?

Not building it yet — core has to harden first, and I'd rather shape it *with*
the people who'd use it than guess. Before I tease it publicly I wanted a sanity
check from someone who'll tell me if it's dumb. So: dumb? Interesting? What's
the first thing you'd poke a hole in?
