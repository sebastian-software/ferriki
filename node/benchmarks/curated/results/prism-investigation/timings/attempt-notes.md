# Timing capture notes

The two full curated captures completed without row/cell errors. The first
focused inline/class invocation did not produce samples: its shell redirection
used a repository-root path while the command ran from `node/`, so zsh could not
open the output file and never started Node. The retry reached the harness but
stopped in the pre-run identity guard because it referenced the quality
fixture-manifest variable instead of the selected curated fixtures. The guard
was corrected to hash the six selected corpus source files, `node --check`
passed, and the following invocation completed all 12 language/size rows with
30 samples per output mode. Neither failed attempt ran a timed render; the
successful retry is the only class-mode result.
