//! Local indexes over the stable Ferroni v2 program / v3 portable envelopes.
//!
//! Asset generation interprets stable envelopes to delegate complete groups.
//! Runtime reads use Ferroni's own record index and import API; opaque payloads
//! are supplied once without constructing reduced archives.

use std::collections::{BTreeSet, HashMap, HashSet};
use std::fs::File;
#[cfg(not(unix))]
use std::io::{Read, Seek, SeekFrom};
use std::time::SystemTime;

use ferroni::scanner::{
    PrecompiledBytes, PrecompiledEager, PrecompiledEagerRecordKind, PrecompiledEagerRecords,
    ScannerConfig,
};
use sha2::{Digest, Sha256};

use crate::PrecompiledPatternsError;
use crate::precompiled::{MAX_ARCHIVE_BYTES, archive_layout};

type Result<T> = std::result::Result<T, PrecompiledPatternsError>;
const INDEX_MAGIC: &[u8; 8] = b"FKIX002\0";
pub(crate) const MAX_INDEX_BYTES: u64 = 16 * 1024 * 1024;
const PROGRAM_MAGIC: &[u8; 8] = b"FERRONI\0";
const GROUP_MAGIC: &[u8; 8] = b"FPRT003\0";
const COALESCE_GAP_BYTES: u64 = 4 * 1024;
const MAX_COALESCED_SPAN_BYTES: u64 = 256 * 1024;
const MAX_SHARED_GAP_BYTES: usize = 512;

/// Fast non-cryptographic 128-bit in-memory key for ordered pattern lists.
/// Cryptographic SHA-256 (`pattern_fingerprint`) remains used for build-time
/// delegation ownership and on-disk asset integrity.
pub(crate) type PatternListKey = [u64; 2];

pub(crate) fn group_lookup(source: &PrecompiledEager) -> Result<HashSet<PatternListKey>> {
    let mut programs = Input(source.program_bytes());
    if programs.take(8)? != PROGRAM_MAGIC || programs.u32()? != 2 {
        return Err(invalid());
    }
    let size = programs.u32()? as usize;
    let mut entries = Input(programs.take(size)?);
    let program_count = entries.count(100_000)?;
    let mut keys = Vec::with_capacity(program_count.min(4096));
    for _ in 0..program_count {
        keys.push(entries.vector()?);
        entries.take(12)?;
    }
    entries.done()?;
    keys.sort_unstable();
    let patterns = keys
        .iter()
        .map(|key| pattern_key(key).map(|(pattern, _)| pattern))
        .collect::<Result<Vec<_>>>()?;
    let mut input = Input(source.group_bytes());
    if input.take(8)? != GROUP_MAGIC {
        return Err(invalid());
    }
    input.take(5)?;
    let group_count = input.count(100_000)?;
    let mut groups = HashSet::with_capacity(group_count.min(4096));
    for _ in 0..group_count {
        let id_count = input.count(65_535)?;
        let mut list = Vec::with_capacity(id_count.min(256));
        for _ in 0..id_count {
            let id = input.u32()?;
            list.push(*patterns.get(id as usize).ok_or_else(invalid)?);
        }
        groups.insert(pattern_list_key(list));
        input.u32()?;
        let size = input.u32()? as usize;
        input.take(size)?;
    }
    input.done()?;
    Ok(groups)
}

struct Index {
    programs: Vec<Program>,
    groups: Vec<Group>,
}

struct Record {
    start: u64,
    len: u32,
    checksum: u32,
}

struct Program {
    key: Vec<u8>,
    record: Record,
}

struct Group {
    ids: Vec<u32>,
    record: Record,
}

/// Keep intrinsic and context-specific groups in their host; delegate exact
/// foreign groups to the package that defines them. Intrinsic groups never
/// delegate, so even mutually embedding languages retain concrete owners.
pub(crate) type IntrinsicGroups = HashMap<String, HashMap<[u8; 32], [u8; 32]>>;

pub(crate) fn intrinsic_groups(
    scope: &str,
    package: &crate::precompiled::PreparedPackage,
) -> Result<HashMap<[u8; 32], [u8; 32]>> {
    let decoded = &package.bytes;
    let index = archive_index(decoded)?;
    let mut groups = HashMap::new();
    for group in &index.groups {
        let owner_key = index.group_fingerprint(group)?;
        if package
            .owners
            .get(&owner_key)
            .is_some_and(|owner| owner == scope)
        {
            groups.insert(
                index.serialized_group_fingerprint(group),
                Sha256::digest(record_bytes(decoded, &group.record)?).into(),
            );
        }
    }
    Ok(groups)
}

pub(crate) fn delegate_package(
    scope: &str,
    package: &crate::precompiled::PreparedPackage,
    intrinsic: &IntrinsicGroups,
) -> Result<Vec<u8>> {
    let decoded = &package.bytes;
    let index = archive_index(decoded)?;
    let mut retained = Vec::new();
    for group in &index.groups {
        let owner_key = index.group_fingerprint(group)?;
        let key = index.serialized_group_fingerprint(group);
        let digest: [u8; 32] = Sha256::digest(record_bytes(decoded, &group.record)?).into();
        let delegate = package.owners.get(&owner_key).is_some_and(|owner| {
            owner != scope
                && intrinsic.get(owner).and_then(|groups| groups.get(&key)) == Some(&digest)
        });
        if !delegate {
            retained.push(group);
        }
    }
    crate::precompiled::compress_archive(&index.subset(decoded, &retained)?)
}

fn record_bytes<'a>(bytes: &'a [u8], record: &Record) -> Result<&'a [u8]> {
    let start = usize::try_from(record.start).map_err(PrecompiledPatternsError::new)?;
    bytes
        .get(start..start.checked_add(record.len as usize).ok_or_else(invalid)?)
        .ok_or_else(invalid)
}

/// Build a small local index for a trusted, decoded prepared container.
///
/// The complete container stays on disk, unchanged. Persist this derived index
/// beside it and attach both with [`crate::SyncRegistry::add_precompiled_patterns_file`].
/// Authenticate the container against trusted producer metadata before calling.
/// Unsupported wire versions return an error; ordinary owned imports remain available.
pub fn index_precompiled_patterns(bytes: &[u8]) -> Result<Vec<u8>> {
    let (program_start, group_start) = archive_layout(bytes)?;
    let archive = crate::precompiled::open_archive(bytes)?;
    let index = archive
        .eager
        .export_record_index()
        .map_err(PrecompiledPatternsError::from_engine)?;
    let mut output = INDEX_MAGIC.to_vec();
    output.extend_from_slice(
        &u32::from_le_bytes(
            bytes[8..12]
                .try_into()
                .map_err(PrecompiledPatternsError::new)?,
        )
        .to_le_bytes(),
    );
    output.extend_from_slice(&(bytes.len() as u64).to_le_bytes());
    number(&mut output, archive.scope.len())?;
    output.extend_from_slice(archive.scope.as_bytes());
    output.extend_from_slice(&(program_start as u64).to_le_bytes());
    output.extend_from_slice(&(group_start as u64).to_le_bytes());
    number(&mut output, index.len())?;
    output.extend_from_slice(&index);
    if output.len() as u64 > MAX_INDEX_BYTES {
        return Err(invalid());
    }
    Ok(output)
}

fn archive_index(bytes: &[u8]) -> Result<Index> {
    let (scope_end, program_end) = archive_layout(bytes)?;
    if bytes.len() as u64 > MAX_ARCHIVE_BYTES
        || ferroni::scanner::PRECOMPILED_FORMAT_VERSION != 2
        || ferroni::scanner::PRECOMPILED_EAGER_FORMAT_VERSION != 3
    {
        return Err(invalid());
    }
    // Check the original pair, including its binding, before deriving offsets.
    // This one-time cache fill may read the complete image; restarts do not.
    crate::precompiled::open_archive(bytes)?;
    let mut header = Input(&bytes[scope_end..program_end]);
    if header.take(8)? != PROGRAM_MAGIC || header.u32()? != 2 {
        return Err(invalid());
    }
    let index_len = header.u32()? as usize;
    let mut entries = Input(header.take(index_len)?);
    let data_start = program_end - header.0.len();
    let mut programs = Vec::new();
    for _ in 0..entries.count(100_000)? {
        let key = entries.vector()?.to_vec();
        let offset = entries.u32()? as usize;
        let len = entries.u32()?;
        let checksum = entries.u32()?;
        programs.push(Program {
            key,
            record: Record {
                start: (data_start + offset) as u64,
                len,
                checksum,
            },
        });
    }
    entries.done()?;
    // Portable group IDs refer to sorted serialized program keys.
    programs.sort_by(|a, b| a.key.cmp(&b.key));
    let mut input = Input(&bytes[program_end..]);
    if input.take(8)? != GROUP_MAGIC {
        return Err(invalid());
    }
    input.u32()?; // Original program binding was checked by Ferroni above.
    if input.take(1)? != [1] {
        return Err(invalid());
    }
    let mut groups = Vec::new();
    for _ in 0..input.count(100_000)? {
        let ids = (0..input.count(65_535)?)
            .map(|_| input.u32())
            .collect::<Result<Vec<_>>>()?;
        let checksum = input.u32()?;
        let len = input.u32()?;
        let start = bytes.len() - input.0.len();
        input.take(len as usize)?;
        groups.push(Group {
            ids,
            record: Record {
                start: start as u64,
                len,
                checksum,
            },
        });
    }
    input.done()?;
    Ok(Index { programs, groups })
}

impl Index {
    fn serialized_group_fingerprint(&self, group: &Group) -> [u8; 32] {
        let mut hash = Sha256::new();
        for id in &group.ids {
            let key = &self.programs[*id as usize].key;
            hash.update((key.len() as u64).to_le_bytes());
            hash.update(key);
        }
        hash.finalize().into()
    }

    fn group_fingerprint(&self, group: &Group) -> Result<[u8; 32]> {
        let patterns = group
            .ids
            .iter()
            .map(|id| pattern_key(&self.programs[*id as usize].key).map(|(pattern, _)| pattern))
            .collect::<Result<Vec<_>>>()?;
        Ok(pattern_fingerprint(patterns))
    }

    fn subset(&self, decoded: &[u8], groups: &[&Group]) -> Result<Vec<u8>> {
        let mut selected = BTreeSet::new();
        for (id, program) in self.programs.iter().enumerate() {
            if !pattern_key(&program.key)?.1 {
                // The source grammar's own static programs were prepared in
                // both settings before any external scanners were visited.
                selected.insert(id as u32);
                let mut key = program.key.clone();
                key[6] = 1;
                if let Ok(id) = self.programs.binary_search_by(|p| p.key.cmp(&key)) {
                    selected.insert(id as u32);
                }
            }
        }
        for group in groups {
            selected.extend(group.ids.iter().copied());
        }
        let selected: Vec<_> = selected.into_iter().collect();
        let mut entries = Vec::new();
        number(&mut entries, selected.len())?;
        let mut offset = 0_usize;
        for id in &selected {
            let program = &self.programs[*id as usize];
            number(&mut entries, program.key.len())?;
            entries.extend_from_slice(&program.key);
            number(&mut entries, offset)?;
            entries.extend_from_slice(&program.record.len.to_le_bytes());
            entries.extend_from_slice(&program.record.checksum.to_le_bytes());
            offset = offset
                .checked_add(program.record.len as usize)
                .ok_or_else(invalid)?;
        }
        let mut programs = PROGRAM_MAGIC.to_vec();
        programs.extend_from_slice(&2_u32.to_le_bytes());
        number(&mut programs, entries.len())?;
        programs.extend_from_slice(&entries);
        for id in &selected {
            programs.extend_from_slice(record_bytes(decoded, &self.programs[*id as usize].record)?);
        }
        let mut portable = GROUP_MAGIC.to_vec();
        portable.extend_from_slice(&binding_checksum(&programs).to_le_bytes());
        portable.push(1);
        number(&mut portable, groups.len())?;
        for group in groups {
            number(&mut portable, group.ids.len())?;
            for id in &group.ids {
                number(
                    &mut portable,
                    selected
                        .binary_search(id)
                        .map_err(PrecompiledPatternsError::new)?,
                )?;
            }
            portable.extend_from_slice(&group.record.checksum.to_le_bytes());
            portable.extend_from_slice(&group.record.len.to_le_bytes());
            portable.extend_from_slice(record_bytes(decoded, &group.record)?);
        }
        // Retain the scope and container version while replacing both sections.
        let (scope_end, _) = archive_layout(decoded)?;
        let mut output = decoded[..scope_end].to_vec();
        output[16..24].copy_from_slice(&(programs.len() as u64).to_le_bytes());
        output[24..32].copy_from_slice(&(portable.len() as u64).to_le_bytes());
        output.extend_from_slice(&programs);
        output.extend_from_slice(&portable);
        crate::precompiled::open_archive(&output)?
            .eager
            .validate_groups()
            .map_err(PrecompiledPatternsError::from_engine)?;
        Ok(output)
    }
}

pub(crate) struct IndexedArchive {
    pub(crate) scope: String,
    file: File,
    size: u64,
    modified: SystemTime,
    program_start: u64,
    group_start: u64,
    records: PrecompiledEagerRecords,
    loaded: HashMap<(PatternListKey, bool), bool>,
    failures: usize,
    pub(crate) bytes_read: u64,
    #[cfg(test)]
    pub(crate) read_calls: usize,
}

impl IndexedArchive {
    pub(crate) fn contains_group(&self, patterns: &[&str], config: &ScannerConfig) -> bool {
        self.records.group(patterns, config, false).is_some()
    }

    pub(crate) fn records(&self) -> PrecompiledEagerRecords {
        self.records.clone()
    }

    pub(crate) fn open(file: File, bytes: &[u8]) -> Result<Self> {
        if bytes.len() as u64 > MAX_INDEX_BYTES {
            return Err(invalid());
        }
        let mut input = Input(bytes);
        if input.take(8)? != INDEX_MAGIC {
            return Err(invalid());
        }
        let format = input.u32()?;
        let size = input.u64()?;
        let scope = std::str::from_utf8(input.vector()?)
            .map_err(PrecompiledPatternsError::new)?
            .to_owned();
        let program_start = input.u64()?;
        let group_start = input.u64()?;
        let records = PrecompiledEagerRecords::from_index(input.vector()?)
            .map_err(PrecompiledPatternsError::from_engine)?;
        input.done()?;
        let metadata = file.metadata().map_err(PrecompiledPatternsError::new)?;
        if !crate::supports_precompiled_patterns_version(format)
            || size > MAX_ARCHIVE_BYTES
            || !metadata.is_file()
            || metadata.len() != size
            || program_start < 32
            || program_start >= group_start
            || group_start >= size
        {
            return Err(invalid());
        }
        for record in records.programs().chain(records.groups()) {
            let (offset, end) = match record.kind() {
                PrecompiledEagerRecordKind::Program => (program_start, group_start),
                PrecompiledEagerRecordKind::Group => (group_start, size),
                _ => return Err(invalid()),
            };
            if offset
                .checked_add(record.range().end as u64)
                .is_none_or(|at| at > end)
            {
                return Err(invalid());
            }
        }
        Ok(Self {
            scope,
            file,
            size,
            modified: metadata.modified().map_err(PrecompiledPatternsError::new)?,
            program_start,
            group_start,
            records,
            loaded: HashMap::new(),
            failures: 0,
            bytes_read: 0,
            #[cfg(test)]
            read_calls: 0,
        })
    }

    pub(crate) fn stats(&self) -> (usize, usize) {
        let stats = self.records.stats();
        (stats.loaded_groups, stats.invalid_groups + self.failures)
    }

    /// Ensures all records for `(patterns, config)` are present in `self.records`.
    ///
    /// Because clones of `PrecompiledEagerRecords` share their underlying payload
    /// storage, callers that already attached `self.records()` do not need to
    /// clear or re-attach precompiled sources after this returns `true`.
    pub(crate) fn ensure_loaded(&mut self, patterns: &[&str], config: &ScannerConfig) -> bool {
        let key = (pattern_list_key(patterns.iter().copied()), config.prefilter);
        if let Some(&loaded) = self.loaded.get(&key) {
            return loaded;
        }
        let loaded = self.read_records(patterns, config).is_ok();
        if !loaded {
            self.failures += 1;
        }
        self.loaded.insert(key, loaded);
        loaded
    }

    #[cfg(test)]
    pub(crate) fn load(
        &mut self,
        patterns: &[&str],
        config: &ScannerConfig,
    ) -> Option<PrecompiledEagerRecords> {
        self.ensure_loaded(patterns, config)
            .then(|| self.records.clone())
    }

    fn unchanged(&self) -> Result<()> {
        let metadata = self
            .file
            .metadata()
            .map_err(PrecompiledPatternsError::new)?;
        if metadata.len() != self.size
            || metadata.modified().map_err(PrecompiledPatternsError::new)? != self.modified
        {
            return Err(invalid());
        }
        Ok(())
    }

    fn read_records(&mut self, patterns: &[&str], config: &ScannerConfig) -> Result<()> {
        #[cfg(feature = "prepared-load-profile")]
        let started = std::time::Instant::now();
        let mut missing = Vec::new();
        let mut seen = HashSet::new();
        for pattern in patterns {
            if let Some(record) = self.records.program(pattern, config, false)
                && !self.records.contains(&record)
                && seen.insert((false, record.id()))
            {
                let range = record.range();
                let start = self
                    .program_start
                    .checked_add(range.start as u64)
                    .ok_or_else(invalid)?;
                let len = range.len();
                let end = start.checked_add(len as u64).ok_or_else(invalid)?;
                if end > self.group_start {
                    return Err(invalid());
                }
                missing.push((start, len, record));
            }
        }
        if let Some(record) = self.records.group(patterns, config, false)
            && !self.records.contains(&record)
            && seen.insert((true, record.id()))
        {
            let range = record.range();
            let start = self
                .group_start
                .checked_add(range.start as u64)
                .ok_or_else(invalid)?;
            let len = range.len();
            let end = start.checked_add(len as u64).ok_or_else(invalid)?;
            if end > self.size {
                return Err(invalid());
            }
            missing.push((start, len, record));
        }
        if missing.is_empty() {
            return Ok(());
        }
        self.unchanged()?;
        missing.sort_unstable_by_key(|(start, _, _)| *start);

        let mut pending = Vec::with_capacity(missing.len());
        let mut i = 0;
        while i < missing.len() {
            let span_start = missing[i].0;
            let mut span_end = span_start
                .checked_add(missing[i].1 as u64)
                .ok_or_else(invalid)?;
            let mut total_record_bytes = missing[i].1;
            let mut j = i + 1;
            while j < missing.len() {
                let (next_start, next_len, _) = missing[j];
                let next_end = next_start
                    .checked_add(next_len as u64)
                    .ok_or_else(invalid)?;
                let gap = next_start.saturating_sub(span_end);
                let merged_end = span_end.max(next_end);
                let merged_len = merged_end.saturating_sub(span_start);
                if gap <= COALESCE_GAP_BYTES && merged_len <= MAX_COALESCED_SPAN_BYTES {
                    span_end = merged_end;
                    total_record_bytes = total_record_bytes.saturating_add(next_len);
                    j += 1;
                } else {
                    break;
                }
            }
            if span_end > self.size {
                return Err(invalid());
            }
            let span_len =
                usize::try_from(span_end - span_start).map_err(PrecompiledPatternsError::new)?;
            let mut buf = Vec::new();
            buf.try_reserve_exact(span_len)
                .map_err(PrecompiledPatternsError::new)?;
            buf.resize(span_len, 0);
            read_exact_at_offset(&mut self.file, span_start, &mut buf)?;
            #[cfg(test)]
            {
                self.read_calls += 1;
            }
            self.bytes_read += span_len as u64;

            if j - i == 1 {
                pending.push((missing[i].2.clone(), PrecompiledBytes::new(buf)));
            } else if span_len.saturating_sub(total_record_bytes) <= MAX_SHARED_GAP_BYTES {
                let shared = PrecompiledBytes::new(buf);
                for (start, len, record) in &missing[i..j] {
                    let rel_start = (*start - span_start) as usize;
                    let rel_end = rel_start + *len;
                    let slice = shared
                        .slice(rel_start..rel_end)
                        .map_err(PrecompiledPatternsError::from_engine)?;
                    pending.push((record.clone(), slice));
                }
            } else {
                for (start, len, record) in &missing[i..j] {
                    let rel_start = (*start - span_start) as usize;
                    let rel_end = rel_start + *len;
                    pending.push((
                        record.clone(),
                        PrecompiledBytes::new(buf[rel_start..rel_end].to_vec()),
                    ));
                }
            }
            i = j;
        }
        self.unchanged()?;
        #[cfg(feature = "prepared-load-profile")]
        let read = started.elapsed().as_nanos();
        #[cfg(feature = "prepared-load-profile")]
        let bytes = pending.iter().map(|(_, bytes)| bytes.len()).sum::<usize>();
        #[cfg(feature = "prepared-load-profile")]
        let count = pending.len();
        for (record, bytes) in pending {
            self.records
                .insert(&record, bytes)
                .map_err(PrecompiledPatternsError::from_engine)?;
        }
        #[cfg(feature = "prepared-load-profile")]
        if std::env::var_os("FERRIKI_PROFILE_PREPARED_PAIRS").is_some() {
            eprintln!(
                "{}",
                serde_json::json!({"scope": self.scope,
                "records": count, "recordBytes": bytes, "readNs": read,
                "insertNs": started.elapsed().as_nanos() - read})
            );
        }
        Ok(())
    }
}

fn read_exact_at_offset(file: &mut File, offset: u64, buf: &mut [u8]) -> Result<()> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::FileExt;
        file.read_exact_at(buf, offset)
            .map_err(PrecompiledPatternsError::new)
    }
    #[cfg(not(unix))]
    {
        file.seek(SeekFrom::Start(offset))
            .map_err(PrecompiledPatternsError::new)?;
        file.read_exact(buf).map_err(PrecompiledPatternsError::new)
    }
}

// Read only the stable program key envelope. Ferroni checks the exact current
// environment/settings again when selecting records or programs.
fn pattern_key(bytes: &[u8]) -> Result<(&str, bool)> {
    let mut input = Input(bytes);
    if input.u32()? != ferroni::oniguruma::ONIG_OPTION_CAPTURE_GROUP.bits()
        || input.take(1)? != [0]
        || input.take(1)? != [0]
    {
        return Err(invalid());
    }
    let prefilter = match input.take(1)? {
        [0] => false,
        [1] => true,
        _ => return Err(invalid()),
    };
    input.take(17)?; // fold, capture/depth/node limits and DFA feature flag
    for _ in 0..input.count(100_000)? {
        input.vector()?;
        let count = input.count(100_000)?;
        input.take(count.checked_mul(4).ok_or_else(invalid)?)?;
    }
    let pattern = std::str::from_utf8(input.vector()?).map_err(PrecompiledPatternsError::new)?;
    input.done()?;
    Ok((pattern, prefilter))
}

fn number(bytes: &mut Vec<u8>, value: usize) -> Result<()> {
    bytes.extend_from_slice(
        &u32::try_from(value)
            .map_err(PrecompiledPatternsError::new)?
            .to_le_bytes(),
    );
    Ok(())
}

struct Input<'a>(&'a [u8]);
impl<'a> Input<'a> {
    fn take(&mut self, len: usize) -> Result<&'a [u8]> {
        let bytes = self.0.get(..len).ok_or_else(invalid)?;
        self.0 = &self.0[len..];
        Ok(bytes)
    }
    fn u32(&mut self) -> Result<u32> {
        Ok(u32::from_le_bytes(
            self.take(4)?
                .try_into()
                .map_err(PrecompiledPatternsError::new)?,
        ))
    }
    fn u64(&mut self) -> Result<u64> {
        Ok(u64::from_le_bytes(
            self.take(8)?
                .try_into()
                .map_err(PrecompiledPatternsError::new)?,
        ))
    }
    fn count(&mut self, max: usize) -> Result<usize> {
        let count = self.u32()? as usize;
        if count > max {
            return Err(invalid());
        }
        Ok(count)
    }
    fn vector(&mut self) -> Result<&'a [u8]> {
        let len = self.u32()? as usize;
        self.take(len)
    }
    fn done(&self) -> Result<()> {
        if self.0.is_empty() {
            Ok(())
        } else {
            Err(invalid())
        }
    }
}

fn invalid() -> PrecompiledPatternsError {
    PrecompiledPatternsError::new("invalid or unsupported indexed prepared archive")
}

// FPRT003's stable striped FNV program binding. Individual record checksums
// remain unchanged and are checked, with instruction validation, by Ferroni.
fn binding_checksum(bytes: &[u8]) -> u32 {
    const PRIME: u64 = 0x0000_0100_0000_01b3;
    let mut lanes = [
        0xcbf2_9ce4_8422_2325_u64,
        0x9e37_79b1_85eb_ca87,
        0xc2b2_ae3d_27d4_eb4f,
        0x1656_67b1_9e37_79f9,
    ];
    let (blocks, tail) = bytes.as_chunks::<32>();
    for block in blocks {
        for (lane, word) in lanes.iter_mut().zip(block.as_chunks::<8>().0) {
            *lane = (*lane ^ u64::from_le_bytes(*word)).wrapping_mul(PRIME);
            *lane ^= *lane >> 29;
        }
    }
    let mut hash = lanes[0]
        ^ lanes[1].rotate_left(13)
        ^ lanes[2].rotate_left(31)
        ^ lanes[3].rotate_left(47)
        ^ bytes.len() as u64;
    let (words, tail) = tail.as_chunks::<8>();
    for word in words {
        hash = (hash ^ u64::from_le_bytes(*word)).wrapping_mul(PRIME);
        hash ^= hash >> 29;
    }
    for byte in tail {
        hash = (hash ^ u64::from(*byte)).wrapping_mul(PRIME);
    }
    hash ^= hash >> 33;
    hash = hash.wrapping_mul(0xff51_afd7_ed55_8ccd);
    hash ^= hash >> 33;
    (hash ^ (hash >> 32)) as u32
}

/// Fast non-cryptographic 128-bit in-memory key for ordered pattern lists.
/// Lengths and order distinguish duplicates and scanner-list boundaries.
pub(crate) fn pattern_list_key<'a>(patterns: impl IntoIterator<Item = &'a str>) -> PatternListKey {
    const PRIME_A: u64 = 0x0000_0100_0000_01b3;
    const PRIME_B: u64 = 0x9e37_79b9_7f4a_7c15;
    let mut h0: u64 = 0xcbf2_9ce4_8422_2325;
    let mut h1: u64 = 0x1656_67b1_9e37_79f9;
    let mut count: u64 = 0;
    for pattern in patterns {
        count = count.wrapping_add(1);
        let bytes = pattern.as_bytes();
        let len = bytes.len() as u64;
        h0 = (h0 ^ len).wrapping_mul(PRIME_A);
        h1 = (h1 ^ len.rotate_left(17)).wrapping_mul(PRIME_B);
        let (chunks, tail) = bytes.as_chunks::<8>();
        for chunk in chunks {
            let word = u64::from_le_bytes(*chunk);
            h0 = (h0 ^ word).wrapping_mul(PRIME_A);
            h0 ^= h0 >> 29;
            h1 = (h1 ^ word.rotate_left(23)).wrapping_mul(PRIME_B);
            h1 ^= h1 >> 31;
        }
        if !tail.is_empty() {
            let mut last = [0_u8; 8];
            last[..tail.len()].copy_from_slice(tail);
            let word = u64::from_le_bytes(last);
            h0 = (h0 ^ word).wrapping_mul(PRIME_A);
            h0 ^= h0 >> 29;
            h1 = (h1 ^ word.rotate_left(23)).wrapping_mul(PRIME_B);
            h1 ^= h1 >> 31;
        }
    }
    h0 ^= count;
    h0 ^= h0 >> 33;
    h0 = h0.wrapping_mul(0xff51_afd7_ed55_8ccd);
    h0 ^= h0 >> 33;
    h1 ^= count.rotate_left(32);
    h1 ^= h1 >> 33;
    h1 = h1.wrapping_mul(0xc4ce_b9fe_1a85_ec53);
    h1 ^= h1 >> 33;
    [h0, h1]
}

/// Lengths and order distinguish duplicates and scanner-list boundaries.
pub(crate) fn pattern_fingerprint<'a>(patterns: impl IntoIterator<Item = &'a str>) -> [u8; 32] {
    let mut hash = Sha256::new();
    for pattern in patterns {
        hash.update((pattern.len() as u64).to_le_bytes());
        hash.update(pattern.as_bytes());
    }
    hash.finalize().into()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};

    #[test]
    fn record_validation_and_file_changes_preserve_fallback() {
        static NEXT: AtomicUsize = AtomicUsize::new(0);
        let raw = crate::parse_raw_grammar(
            r#"{"scopeName":"source.indexed","patterns":[
                {"match":"outer"},
                {"begin":"<","end":">","patterns":[{"match":"inner"}]},
                {"begin":"\\[","end":"\\]","patterns":[{"match":"rare"}]}
            ]}"#,
            Some("indexed.json"),
        )
        .unwrap();
        let mut bytes = crate::decompress_precompiled_patterns(
            &crate::precompile_grammar_patterns(&raw).unwrap(),
        )
        .unwrap();
        let original = archive_index(&bytes).unwrap();
        let index = index_precompiled_patterns(&bytes).unwrap();
        let path = std::env::temp_dir().join(format!(
            "ferriki-indexed-record-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        let config =
            crate::regexp::scanner_config(true).acceleration(ferroni::AccelerationMode::Eager);
        let lists = original
            .groups
            .iter()
            .map(|group| {
                group
                    .ids
                    .iter()
                    .map(|id| {
                        pattern_key(&original.programs[*id as usize].key)
                            .unwrap()
                            .0
                            .to_owned()
                    })
                    .collect::<Vec<_>>()
            })
            .collect::<Vec<_>>();
        std::fs::write(&path, &bytes).unwrap();
        let mut source = IndexedArchive::open(File::open(&path).unwrap(), &index).unwrap();
        for patterns in &lists {
            let patterns = patterns.iter().map(String::as_str).collect::<Vec<_>>();
            let records = source.load(&patterns, &config).unwrap();
            assert!(
                records
                    .validate_record(&records.group(&patterns, &config, false).unwrap())
                    .unwrap()
            );
        }
        let read = source.bytes_read;
        for patterns in &lists {
            source
                .load(
                    &patterns.iter().map(String::as_str).collect::<Vec<_>>(),
                    &config,
                )
                .unwrap();
        }
        assert_eq!(source.bytes_read, read);
        let bad = original
            .groups
            .iter()
            .find(|group| {
                group.ids.iter().any(|id| {
                    pattern_key(&original.programs[*id as usize].key).unwrap().0 == "rare"
                })
            })
            .unwrap();
        bytes[bad.record.start as usize + bad.record.len as usize - 1] ^= 1;
        drop(source);
        std::fs::write(&path, &bytes).unwrap();
        let mut source = IndexedArchive::open(File::open(&path).unwrap(), &index).unwrap();
        for patterns in &lists {
            let patterns = patterns.iter().map(String::as_str).collect::<Vec<_>>();
            let records = source.load(&patterns, &config).unwrap();
            assert_eq!(
                records
                    .validate_record(&records.group(&patterns, &config, false).unwrap())
                    .is_err(),
                patterns.contains(&"rare")
            );
        }
        drop(source);
        let mut source = IndexedArchive::open(File::open(&path).unwrap(), &index).unwrap();
        File::options()
            .write(true)
            .open(&path)
            .unwrap()
            .set_modified(SystemTime::UNIX_EPOCH)
            .unwrap();
        let patterns = lists[0].iter().map(String::as_str).collect::<Vec<_>>();
        assert!(source.load(&patterns, &config).is_none());
        assert_eq!(source.bytes_read, 0);
        assert_eq!(source.stats().1, 1);
        assert!(source.load(&patterns, &config).is_none());
        assert_eq!(source.stats().1, 1);
        drop(source);
        let mut bad_index = index.clone();
        bad_index[12..20].copy_from_slice(&u64::MAX.to_le_bytes());
        assert!(IndexedArchive::open(File::open(&path).unwrap(), &bad_index).is_err());
        std::fs::remove_file(path).unwrap();
    }

    #[test]
    fn pattern_list_key_distinguishes_order_lengths_and_duplicates() {
        assert_ne!(pattern_list_key(["ab", "c"]), pattern_list_key(["a", "bc"]));
        assert_ne!(pattern_list_key(["a", "b"]), pattern_list_key(["b", "a"]));
        assert_ne!(pattern_list_key(["a"]), pattern_list_key(["a", "a"]));
        assert_ne!(pattern_list_key([] as [&str; 0]), pattern_list_key([""]));
        assert_eq!(
            pattern_list_key(["alpha", "beta", "gamma"]),
            pattern_list_key(["alpha", "beta", "gamma"])
        );
    }

    #[test]
    fn coalesced_record_reads_reduce_syscalls_and_reject_truncation() {
        static NEXT: AtomicUsize = AtomicUsize::new(100);
        let raw = crate::parse_raw_grammar(
            r#"{"scopeName":"source.coalesce","patterns":[
                {"match":"alpha"},
                {"match":"beta"},
                {"match":"gamma"},
                {"match":"delta"},
                {"match":"epsilon"},
                {"match":"zeta"},
                {"match":"eta"},
                {"match":"theta"}
            ]}"#,
            Some("coalesce.json"),
        )
        .unwrap();
        let bytes = crate::decompress_precompiled_patterns(
            &crate::precompile_grammar_patterns(&raw).unwrap(),
        )
        .unwrap();
        let original = archive_index(&bytes).unwrap();
        let index = index_precompiled_patterns(&bytes).unwrap();
        let path = std::env::temp_dir().join(format!(
            "ferriki-indexed-coalesce-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        let config =
            crate::regexp::scanner_config(true).acceleration(ferroni::AccelerationMode::Eager);
        let group = original
            .groups
            .iter()
            .max_by_key(|group| group.ids.len())
            .unwrap();
        assert!(group.ids.len() >= 8);
        let patterns: Vec<String> = group
            .ids
            .iter()
            .map(|id| {
                pattern_key(&original.programs[*id as usize].key)
                    .unwrap()
                    .0
                    .to_owned()
            })
            .collect();
        let pattern_refs: Vec<&str> = patterns.iter().map(String::as_str).collect();

        std::fs::write(&path, &bytes).unwrap();
        let mut source = IndexedArchive::open(File::open(&path).unwrap(), &index).unwrap();
        let records = source.load(&pattern_refs, &config).unwrap();
        let read_calls = source.read_calls;
        let bytes_read = source.bytes_read;
        assert!(
            read_calls > 0 && read_calls < group.ids.len(),
            "expected coalesced reads ({read_calls}) to be fewer than individual records ({})",
            group.ids.len() + 1
        );
        for pattern in &pattern_refs {
            let record = records.program(pattern, &config, false).unwrap();
            assert!(records.validate_record(&record).unwrap());
        }
        assert!(
            records
                .validate_record(&records.group(&pattern_refs, &config, false).unwrap())
                .unwrap()
        );
        // Repeat load is an in-memory cache hit with zero extra syscalls or I/O.
        assert!(source.ensure_loaded(&pattern_refs, &config));
        assert_eq!(source.read_calls, read_calls);
        assert_eq!(source.bytes_read, bytes_read);
        drop(source);

        // Truncating the backing file after open must be rejected cleanly before inserting records.
        let mut truncated_source =
            IndexedArchive::open(File::open(&path).unwrap(), &index).unwrap();
        File::options()
            .write(true)
            .open(&path)
            .unwrap()
            .set_len(bytes.len() as u64 / 2)
            .unwrap();
        assert!(!truncated_source.ensure_loaded(&pattern_refs, &config));
        assert_eq!(truncated_source.read_calls, 0);
        assert_eq!(truncated_source.bytes_read, 0);
        assert_eq!(truncated_source.stats().1, 1);
        drop(truncated_source);
        std::fs::remove_file(path).unwrap();
    }
}
