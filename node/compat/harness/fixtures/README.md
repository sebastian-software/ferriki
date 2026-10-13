# Pinned Grammar Fixture Data

`yaml-v4.4.3.json` is the YAML grammar used by the immutable Shiki v4.4.3
snapshot fixtures, from the pinned `tm-grammars` 1.32.3 development dependency.
Its original source is `textmate/yaml.tmbundle` at commit
`e54ceae3b719506dba7e481a77cea4a8b576ae46`.

The native compatibility adapter uses this data for YAML color/merging
snapshots. It still invokes Ferriki's native tokenizer and renderer. Product
grammars follow independent repository snapshots and are compared through
identical current data in both engines by the corpus checks. This fixture is
not part of the published package or standard source catalog.

The original bundle's permission notice applies:

Permission to copy, use, modify, sell and distribute this
software is granted. This software is provided "as is" without
express or implied warranty, and with no claim as to its
suitability for any purpose.
