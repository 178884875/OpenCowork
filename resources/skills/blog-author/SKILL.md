---
name: blog-author
description: Research a topic deeply, plan a blog step by step, and write a long-form article with structured Markdown outputs in the current working directory. Supports multilingual writing, source tracking, metadata generation, and optional image insertion via available image tools.
compatibility: Pure prompt skill. Does not require bundled scripts. Works best when the session has file-writing capability and may optionally use available web research or image-generation tools.
---

# Blog Author

Research a user topic thoroughly, plan the article in stages, and write a long-form blog post for general content platforms.

## When to use this skill

- The user gives a topic or requirement and wants a blog post
- The user wants deep background collection before writing
- The user wants the blog planned step by step instead of generating everything at once
- The user wants Markdown output in the current working directory
- The user may want optional images inserted into the article
- The user may later convert the result into other formats such as `.docx`

## Non-goals

- Do not convert output to `.docx` inside this skill
- Do not rely on any other skill as a required dependency
- Do not publish the article to any platform
- Do not fabricate facts, sources, quotes, data, or image assets
- Do not skip the planning stages and jump straight to a final draft unless the user explicitly asks for that shortcut

## Default behavior

- Default output language is user-specified; if unspecified, ask before drafting
- Default writing mode is long-form
- Default target is a general content platform style
- Default working pattern is: research -> outline -> section design -> draft -> final
- Default source policy is: keep a separate source list, avoid stuffing hard citations into the main body unless the user asks for them
- Default folder policy is: create a topic subfolder under the current working directory using an English slug
- Default file set is:
  - `post.md`
  - `research.md`
  - `sources.md`
  - `metadata.md`
- Default image policy is: use images only when they materially improve clarity or presentation, and if images are generated, the article may reference absolute image paths returned by the tool

## Required operating rules

1. Always understand the user goal before writing.
2. If key information is missing, ask the minimum necessary questions first.
3. If the user already provided materials, process those materials before adding external research.
4. Collect background information as fully as the current session allows.
5. Work in stages. Do not merge all stages into one opaque response.
6. Persist outputs to files in the current working directory, not only in chat.
7. Keep each file focused on its purpose.
8. State uncertainty clearly when facts are incomplete, time-sensitive, high-risk, or disputed.
9. For high-risk domains, narrow claims and prefer cautious wording.
10. If the session lacks a web-capable tool, say so clearly and continue with user-provided materials plus general known context, marking the limitation.

## Minimum clarification checklist

Ask only what is necessary. Typical missing items:

- Topic or core requirement
- Target audience
- Output language
- Target platform or style expectations
- Time sensitivity
- Whether the user already has notes, links, data, or source material
- Whether images are desired

If the user already specified enough information, do not re-ask obvious questions.

## Workflow

You must proceed in the following order unless the user explicitly requests a different scope.

### Stage 1: Research

Goal: build a reliable fact base and topic framing before writing.

Actions:

1. Read and digest all user-provided materials first.
2. If the current session provides web or retrieval tools, gather more context from multiple sources.
3. Prefer source quality in this order:
   - official or primary sources
   - reputable institutions, standards, reports, or major industry publications
   - strong secondary analysis and case studies
   - community posts or personal blogs only as supporting context
4. Identify:
   - definitions and key concepts
   - current context and trends
   - important facts, data points, and examples
   - disagreements, caveats, or uncertainty
   - platform-appropriate angles for the intended audience
5. Separate confirmed facts from tentative observations.
6. If facts conflict, note the conflict instead of forcing false certainty.

Write findings to `research.md`.

`research.md` should usually include:

- Topic statement
- Audience assumptions
- Research scope
- Key facts and takeaways
- Important background context
- Possible article angles
- Open questions or missing information
- Risk or uncertainty notes when applicable

### Stage 2: Sources

Goal: preserve traceability without making the main article heavy.

Write source tracking to `sources.md`.

`sources.md` should usually include:

- A numbered source list
- Title or source name
- Link or identifier when available
- Source type
- Short note on why it matters
- Time relevance if important
- Reliability caveat if needed

Do not invent URLs or bibliographic details.

### Stage 3: Outline

Goal: decide the article structure before prose drafting.

Produce a clear outline in chat and also store it in `research.md` or `metadata.md` if useful.

The outline should define:

- Working title direction
- Main thesis or central promise
- Section order
- What each section is supposed to accomplish
- Where examples, comparisons, data, or stories should appear
- What the reader should understand by the end

After presenting the outline, pause for confirmation if the user has not asked for fully automatic continuation.

### Stage 4: Section Design

Goal: expand the outline into a writing blueprint.

For each planned section, define:

- Section objective
- Core points
- Evidence or examples to use
- Tone and depth
- Suggested transitions
- Whether a diagram, illustration, or cover image would help

If the topic benefits from visuals and the session includes an image-generation tool, optionally prepare image prompts.

### Stage 5: Draft

Goal: write a strong first full version.

Write the article to `post.md`.

Default article requirements:

- Long-form structure
- Strong opening hook
- Clear section hierarchy
- Natural transitions
- Content-platform-friendly readability
- Accurate claims based on the research stage
- No fake certainty
- Avoid unnecessary citation clutter in the main body unless requested

If the user asked for another language, write directly in that language.

### Stage 6: Metadata

Goal: prepare platform-ready supporting material.

Write `metadata.md` with at least:

- 3 to 8 title options
- 1 short summary
- 1 longer abstract or intro blurb
- Recommended tags or keywords
- Cover image suggestion
- Tone/style note for the intended platform
- Optional CTA ideas if suitable

### Stage 7: Finalization

Goal: refine and make the deliverables consistent.

Before finishing:

1. Check the article against the research facts.
2. Remove contradictions, vague filler, and duplicated points.
3. Ensure the structure still matches the approved plan.
4. Ensure all required files exist.
5. Summarize what was generated and where it was saved.

## Output directory contract

Create a subfolder under the current working directory using an English slug derived from the topic.

Example:

```text
<current working directory>/<topic-slug>/
  post.md
  research.md
  sources.md
  metadata.md
```

Rules:

- Prefer a clean English slug for the folder name
- If the topic is non-English, still generate a stable English slug when possible
- If a safe slug is unclear, ask the user once before writing files
- Keep all default article files inside that folder

## Image policy

Images are optional, not mandatory.

Use images only if they improve one of these:

- conceptual clarity
- visual explanation
- reader engagement
- cover presentation

If an image is generated using an available image tool:

- use a precise prompt aligned with the article section or cover concept
- do not pretend an image exists before generation succeeds
- if the tool returns absolute file paths, you may reference those absolute paths in `post.md`
- mention clearly where the image belongs in the article
- do not create a fake local image file manifest unless the user asks for one

If no image tool is available, provide suggested prompts and placement notes instead of fabricating output.

## High-risk and time-sensitive topics

For topics involving medicine, law, finance, investment, regulation, policy interpretation, or breaking news:

- explicitly state uncertainty and scope limits
- prefer verified and recent sources
- avoid definitive advice language unless the user explicitly wants a non-advisory summary and the evidence supports it
- narrow conclusions to what is actually supported
- flag location and time sensitivity when relevant

## Decision rules for missing capabilities

If web research is not possible in the current session:

- say that external research is limited in this run
- continue with user-provided materials and generally known background only
- mark assumptions and confidence level in `research.md`

If file writing is not possible:

- explain the limitation
- still produce staged content in chat
- tell the user which files should be created once writing is available

If image generation is unavailable:

- provide image suggestions and prompts only

## Writing quality bar

The final article should aim for:

- useful substance, not generic filler
- a clear point of view grounded in research
- audience-aware language
- strong information flow
- platform-friendly readability
- restrained claims when evidence is weak
- multilingual adaptability when requested

## Final response pattern

At the end of the task, report briefly:

- chosen topic slug
- generated files
- whether research used external sources or only user materials
- whether any image paths were inserted into `post.md`
- any remaining uncertainty or follow-up suggestions
