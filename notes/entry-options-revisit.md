# Revisit EntryOptions

Plugins return `EntryOptions` (collection, body, frontmatter, filename) and
the SDK serializes that into `<runDir>/<filename>` for the host to promote.
Working through raindrop made a few rough edges visible — worth thinking
about together rather than papering over per-plugin.

## Pain points hit

- **Flat run dir → filename collisions across collections.** Bookmark and
  cache both wanted `${id}.md`. Same id, different collection, but the run
  dir is flat so the second write clobbered the first. Worked around by
  prefixing the cache id (`cache-${b._id}`). The collection is already a
  namespace; the on-disk filename shouldn't have to repeat that.

- **No way to write non-md assets.** Raindrop ships a permanent HTML cache
  per bookmark. We pulled it, ran Readability, wrote the extracted `.md` —
  but the raw `.html` had nowhere to go. `planPromotion` only picks up
  `.md` files with `source`/`collection` frontmatter. So the original
  artefact (the thing that survives link rot) is dropped on the floor.
  Same gap will hit any plugin that wants to keep PDFs, screenshots,
  audio transcripts alongside an entry.

- **Sibling/companion files are awkward.** A bookmark and its extracted
  cache are conceptually one record with two faces. Today we model them as
  two unrelated entries linked only by `dither_parent_id` frontmatter.
  Fine, but heavyweight: two files, two frontmatter blocks, two index
  rows, no automatic joint deletion.

- **Repetitive frontmatter shape.** Every plugin re-derives `id`,
  `external_id`, `url`, `title`, `kind`, parent linkage. Worth checking if
  there's a smaller core shape the SDK could enforce/auto-stamp, leaving
  plugin-specific fields free.

## Things to think about

- Should the SDK accept a stable id + collection and pick the run-dir
  filename itself (or hash collection+id)? Plugins shouldn't need to know
  the run dir is flat.

- Asset companion API: e.g. `writeAsset({ entry, name, body|path,
  contentType })` that promotes a non-md file alongside an entry without
  forcing it through the markdown frontmatter pipeline.

- Group/record concept: a way to mark "these N files are one logical
  record" so reindex and deletion treat them together.

- Make `dither_parent_id`/`dither_parent_path` first-class on
  `EntryOptions` (not just a frontmatter convention) so the host can
  validate and the search index can join.

- Conventions for `kind` / `source` overlap: today `source` is the plugin
  name, `kind` is plugin-defined. Probably fine, but worth writing down.

## Not urgent

None of this is blocking. raindrop ships fine without it. But if a third
or fourth plugin hits the same shape we should design rather than each
plugin re-inventing the workaround.
