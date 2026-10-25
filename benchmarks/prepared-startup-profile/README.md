# Prepared startup phase diagnostic

This private probe answers why fresh-process Prepared startup differs between
the Linux x86-64 and macOS ARM64 Blacksmith profiles. It changes no runtime API
or addon feature. Its lockfile matches the production versions of shared
dependencies.

The Blacksmith workflow's `startup-profile` suite calls
`prepared-startup-profile.yml` on both hosts. It builds the
ordinary release addon, populates the decoded cache, verifies all requested
files and their size/mtime receipts, then runs these diagnostics serially:

- The existing full-HTML worker splits module import, highlighter factory,
  first render and repeated rendering for the same fourteen-file corpus.
  Five fresh processes per Off/Auto/Eager/Prepared mode rotate their order.
  Complete output hashes must match; archive diagnostics remain required.
- A separate Rust process reads and retains only those fourteen decoded
  containers, then opens their shared program/group views through Ferroni.
  Five processes per reader rotate the production `Take<File>` shape,
  direct `File::read_to_end`, and a bounded zeroed buffer with `read_exact`.
  Byte counts and unchanged file
  metadata are checked. The probe omits the small receipt reads; the ordinary
  Node entry point above retains them.
- Only after those measurements, a separate probe build enables Ferroni's
  `scanner-load-profile` clocks and reports archive-opening subphases.
  These clocks do not enter the measured addon or normal probe.

Input reads, downloads, first decoded fill and process creation are outside
the timers. Filesystem pages may be warm. The phase worker reads input before
its import timer, unlike the original headline benchmark, which reads corpus
files inside its first-use timer. This is a diagnostic boundary, not a
replacement for the headline table. No memory-map experiment is involved.

The workflow retains the inputs, archive identities, normal addon receipt,
normal probe identity, all samples and separate engine phase output.
