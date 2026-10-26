//! Local indexes over the stable Ferroni v2 program / v3 portable envelopes.
//!
//! Only envelopes are interpreted here. Requested opaque records are assembled
//! into a smaller, rebound pair and passed through Ferroni's normal validators.
//! No bytecode or automaton instructions are decoded by this module.

use std::collections::{BTreeSet, HashMap, HashSet};
use std::fs::File;
use std::io::{Read, Seek, SeekFrom};
use std::time::SystemTime;

use ferroni::scanner::{PrecompiledEager, PrecompiledEagerStats};
use sha2::{Digest, Sha256};

use crate::PrecompiledPatternsError;
use crate::precompiled::{MAX_ARCHIVE_BYTES, archive_layout};

type Result<T> = std::result::Result<T, PrecompiledPatternsError>;
const INDEX_MAGIC: &[u8; 8] = b"FKIX001\0";
pub(crate) const MAX_INDEX_BYTES: u64 = 16 * 1024 * 1024;
const PROGRAM_MAGIC: &[u8; 8] = b"FERRONI\0";
const GROUP_MAGIC: &[u8; 8] = b"FPRT003\0";

pub(crate) fn group_lookup(source: &PrecompiledEager) -> Result<HashSet<[u8; 32]>> {
    let mut programs = Input(source.program_bytes());
    if programs.take(8)? != PROGRAM_MAGIC || programs.u32()? != 2 {
        return Err(invalid());
    }
    let size = programs.u32()? as usize;
    let mut entries = Input(programs.take(size)?);
    let mut keys = Vec::new();
    for _ in 0..entries.count(100_000)? {
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
    let mut groups = HashSet::new();
    for _ in 0..input.count(100_000)? {
        let ids = (0..input.count(65_535)?)
            .map(|_| input.u32())
            .collect::<Result<Vec<_>>>()?;
        let list = ids
            .iter()
            .map(|id| patterns.get(*id as usize).copied().ok_or_else(invalid))
            .collect::<Result<Vec<_>>>()?;
        groups.insert(pattern_fingerprint(list));
        input.u32()?;
        let size = input.u32()? as usize;
        input.take(size)?;
    }
    input.done()?;
    Ok(groups)
}

struct Index {
    format: u32,
    scope: String,
    size: u64,
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
    let bytes = archive_index(bytes)?.encode()?;
    if bytes.len() as u64 > MAX_INDEX_BYTES {
        return Err(invalid());
    }
    Ok(bytes)
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
    Ok(Index {
        format: u32::from_le_bytes(
            bytes[8..12]
                .try_into()
                .map_err(PrecompiledPatternsError::new)?,
        ),
        scope: std::str::from_utf8(&bytes[32..scope_end])
            .map_err(PrecompiledPatternsError::new)?
            .to_owned(),
        size: bytes.len() as u64,
        programs,
        groups,
    })
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

    fn encode(&self) -> Result<Vec<u8>> {
        let mut bytes = INDEX_MAGIC.to_vec();
        bytes.extend_from_slice(&self.format.to_le_bytes());
        bytes.extend_from_slice(&self.size.to_le_bytes());
        number(&mut bytes, self.scope.len())?;
        bytes.extend_from_slice(self.scope.as_bytes());
        number(&mut bytes, self.programs.len())?;
        for program in &self.programs {
            number(&mut bytes, program.key.len())?;
            bytes.extend_from_slice(&program.key);
            program.record.write(&mut bytes);
        }
        number(&mut bytes, self.groups.len())?;
        for group in &self.groups {
            number(&mut bytes, group.ids.len())?;
            for id in &group.ids {
                bytes.extend_from_slice(&id.to_le_bytes());
            }
            group.record.write(&mut bytes);
        }
        Ok(bytes)
    }

    fn decode(bytes: &[u8]) -> Result<Self> {
        let mut input = Input(bytes);
        if input.take(8)? != INDEX_MAGIC {
            return Err(invalid());
        }
        let format = input.u32()?;
        let size = input.u64()?;
        let scope = std::str::from_utf8(input.vector()?)
            .map_err(PrecompiledPatternsError::new)?
            .to_owned();
        let mut programs = Vec::new();
        for _ in 0..input.count(100_000)? {
            programs.push(Program {
                key: input.vector()?.to_vec(),
                record: Record::read(&mut input)?,
            });
        }
        let mut groups = Vec::new();
        for _ in 0..input.count(100_000)? {
            let ids = (0..input.count(65_535)?)
                .map(|_| input.u32())
                .collect::<Result<Vec<_>>>()?;
            groups.push(Group {
                ids,
                record: Record::read(&mut input)?,
            });
        }
        input.done()?;
        Ok(Self {
            format,
            scope,
            size,
            programs,
            groups,
        })
    }
}

impl Record {
    fn write(&self, bytes: &mut Vec<u8>) {
        bytes.extend_from_slice(&self.start.to_le_bytes());
        bytes.extend_from_slice(&self.len.to_le_bytes());
        bytes.extend_from_slice(&self.checksum.to_le_bytes());
    }
    fn read(input: &mut Input<'_>) -> Result<Self> {
        Ok(Self {
            start: input.u64()?,
            len: input.u32()?,
            checksum: input.u32()?,
        })
    }
}

pub(crate) struct IndexedArchive {
    pub(crate) scope: String,
    file: File,
    size: u64,
    modified: SystemTime,
    programs: Vec<Program>,
    program_range: std::ops::Range<u64>,
    program_chunks: HashMap<u64, Vec<u8>>,
    ids: HashMap<String, u32>,
    groups: HashMap<Vec<u32>, Record>,
    loaded: HashMap<Vec<u32>, Option<PrecompiledEager>>,
    failures: usize,
    pub(crate) bytes_read: u64,
}

impl IndexedArchive {
    pub(crate) fn contains_group(&self, patterns: &[&str]) -> bool {
        patterns
            .iter()
            .map(|pattern| self.ids.get(*pattern).copied())
            .collect::<Option<Vec<_>>>()
            .is_some_and(|ids| self.groups.contains_key(&ids))
    }

    pub(crate) fn open(file: File, bytes: &[u8]) -> Result<Self> {
        if bytes.len() as u64 > MAX_INDEX_BYTES {
            return Err(invalid());
        }
        let index = Index::decode(bytes)?;
        let metadata = file.metadata().map_err(PrecompiledPatternsError::new)?;
        if !crate::supports_precompiled_patterns_version(index.format)
            || ferroni::scanner::PRECOMPILED_FORMAT_VERSION != 2
            || ferroni::scanner::PRECOMPILED_EAGER_FORMAT_VERSION != 3
            || index.size > MAX_ARCHIVE_BYTES
            || !metadata.is_file()
            || metadata.len() != index.size
            || index.programs.len() > 100_000
            || index.groups.len() > 100_000
        {
            return Err(invalid());
        }
        let mut ids = HashMap::new();
        let (mut program_start, mut program_end) = (u64::MAX, 0);
        for (id, program) in index.programs.iter().enumerate() {
            check_record(&program.record, index.size, 16 << 20)?;
            let (pattern, prefilter) = pattern_key(&program.key)?;
            if prefilter && ids.insert(pattern.to_owned(), id as u32).is_some() {
                return Err(invalid());
            }
            if prefilter {
                program_start = program_start.min(program.record.start);
                program_end = program_end.max(program.record.start + u64::from(program.record.len));
            }
            if id > 0 && index.programs[id - 1].key >= program.key {
                return Err(invalid());
            }
        }
        let mut groups = HashMap::new();
        for group in index.groups {
            check_record(&group.record, index.size, 64 << 20)?;
            if group.ids.len() > 65_535
                || group
                    .ids
                    .iter()
                    .any(|id| *id as usize >= index.programs.len())
                || groups.insert(group.ids, group.record).is_some()
            {
                return Err(invalid());
            }
        }
        Ok(Self {
            scope: index.scope,
            file,
            size: index.size,
            modified: metadata.modified().map_err(PrecompiledPatternsError::new)?,
            program_range: program_start.min(program_end)..program_end,
            program_chunks: HashMap::new(),
            programs: index.programs,
            ids,
            groups,
            loaded: HashMap::new(),
            failures: 0,
            bytes_read: 0,
        })
    }

    pub(crate) fn stats(&self) -> (usize, usize) {
        self.loaded
            .values()
            .flatten()
            .fold((0, self.failures), |(loads, failures), source| {
                let PrecompiledEagerStats {
                    loaded_groups,
                    invalid_groups,
                    ..
                } = source.stats();
                (loads + loaded_groups, failures + invalid_groups)
            })
    }

    pub(crate) fn load(&mut self, patterns: &[&str]) -> Option<PrecompiledEager> {
        let ids = patterns
            .iter()
            .map(|pattern| self.ids.get(*pattern).copied())
            .collect::<Option<Vec<_>>>()?;
        if let Some(source) = self.loaded.get(&ids) {
            return source.clone();
        }
        let source = self.read_pair(&ids).ok();
        if source.is_none() {
            self.failures += 1;
        }
        self.loaded.insert(ids, source.clone());
        source
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

    fn read_pair(&mut self, ids: &[u32]) -> Result<PrecompiledEager> {
        #[cfg(feature = "prepared-load-profile")]
        let started = std::time::Instant::now();
        self.unchanged()?;
        let mut selected = ids.to_vec();
        selected.sort_unstable();
        selected.dedup();
        let mut index = Vec::new();
        number(&mut index, selected.len())?;
        let mut data_len = 0_usize;
        for id in &selected {
            let program = &self.programs[*id as usize];
            number(&mut index, program.key.len())?;
            index.extend_from_slice(&program.key);
            number(&mut index, data_len)?;
            index.extend_from_slice(&program.record.len.to_le_bytes());
            index.extend_from_slice(&program.record.checksum.to_le_bytes());
            data_len = data_len
                .checked_add(program.record.len as usize)
                .ok_or_else(invalid)?;
            if data_len > 256 << 20 {
                return Err(invalid());
            }
        }
        let mut programs = PROGRAM_MAGIC.to_vec();
        programs.extend_from_slice(&2_u32.to_le_bytes());
        number(&mut programs, index.len())?;
        programs.extend_from_slice(&index);
        if programs
            .len()
            .checked_add(data_len)
            .is_none_or(|len| len > 256 << 20)
        {
            return Err(invalid());
        }
        programs.reserve(data_len);
        #[cfg(feature = "prepared-load-profile")]
        let indexed = started.elapsed().as_nanos();
        for id in &selected {
            self.append_program(*id as usize, &mut programs)?;
        }
        #[cfg(feature = "prepared-load-profile")]
        let copied = started.elapsed().as_nanos();
        let mut groups = GROUP_MAGIC.to_vec();
        groups.extend_from_slice(&binding_checksum(&programs).to_le_bytes());
        groups.push(1);
        #[cfg(feature = "prepared-load-profile")]
        let bound = started.elapsed().as_nanos();
        if let Some(record) = self.groups.get(ids) {
            number(&mut groups, 1)?;
            number(&mut groups, ids.len())?;
            for id in ids {
                number(
                    &mut groups,
                    selected
                        .binary_search(id)
                        .map_err(PrecompiledPatternsError::new)?,
                )?;
            }
            groups.extend_from_slice(&record.checksum.to_le_bytes());
            groups.extend_from_slice(&record.len.to_le_bytes());
            read_record(&mut self.file, record, &mut groups)?;
            self.bytes_read += u64::from(record.len);
        } else {
            number(&mut groups, 0)?;
        }
        self.unchanged()?;
        #[cfg(feature = "prepared-load-profile")]
        let read = started.elapsed().as_nanos();
        #[cfg(feature = "prepared-load-profile")]
        let program_bytes = programs.len();
        let source = PrecompiledEager::from_shared_bytes(programs.into(), groups.into())
            .map_err(PrecompiledPatternsError::from_engine);
        #[cfg(feature = "prepared-load-profile")]
        if std::env::var_os("FERRIKI_PROFILE_PREPARED_PAIRS").is_some() {
            eprintln!(
                "{}",
                serde_json::json!({"scope": self.scope, "programs": selected.len(),
                    "programBytes": program_bytes, "indexNs": indexed,
                    "programReadCopyNs": copied - indexed, "bindingNs": bound - copied,
                    "groupReadNs": read - bound, "openNs": started.elapsed().as_nanos() - read})
            );
        }
        source
    }

    fn append_program(&mut self, id: usize, output: &mut Vec<u8>) -> Result<()> {
        let record = &self.programs[id].record;
        let mut cursor = record.start;
        let end = record.start + u64::from(record.len);
        // Amortize small seeks/allocations while retaining demand-driven
        // reads. A record may cross chunks; no alignment is assumed.
        const CHUNK_BYTES: u64 = 256 * 1024;
        while cursor < end {
            let chunk = (cursor - self.program_range.start) / CHUNK_BYTES;
            let start = self.program_range.start + chunk * CHUNK_BYTES;
            if let std::collections::hash_map::Entry::Vacant(entry) =
                self.program_chunks.entry(chunk)
            {
                let len = (self.program_range.end - start).min(CHUNK_BYTES) as u32;
                let mut bytes = Vec::new();
                read_record(
                    &mut self.file,
                    &Record {
                        start,
                        len,
                        checksum: 0,
                    },
                    &mut bytes,
                )?;
                self.bytes_read += u64::from(len);
                entry.insert(bytes);
            }
            let bytes = &self.program_chunks[&chunk];
            let offset = (cursor - start) as usize;
            let len = (end - cursor).min((bytes.len() - offset) as u64) as usize;
            output.extend_from_slice(&bytes[offset..offset + len]);
            cursor += len as u64;
        }
        Ok(())
    }
}

fn check_record(record: &Record, size: u64, max: u32) -> Result<()> {
    if record.len == 0
        || record.len > max
        || record
            .start
            .checked_add(u64::from(record.len))
            .is_none_or(|end| end > size)
    {
        return Err(invalid());
    }
    Ok(())
}

fn read_record(file: &mut File, record: &Record, bytes: &mut Vec<u8>) -> Result<()> {
    file.seek(SeekFrom::Start(record.start))
        .map_err(PrecompiledPatternsError::new)?;
    let start = bytes.len();
    bytes.resize(
        start.checked_add(record.len as usize).ok_or_else(invalid)?,
        0,
    );
    file.read_exact(&mut bytes[start..])
        .map_err(PrecompiledPatternsError::new)
}

// Read only the stable program key envelope. Ferroni checks the exact current
// environment/settings again when selecting programs from each reduced pair.
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
    fn program_chunks_cross_boundaries_reuse_data_and_stop_at_the_program_end() {
        let bytes: Vec<_> = (0..700_123).map(|i| (i % 251) as u8).collect();
        let path =
            std::env::temp_dir().join(format!("ferriki-program-chunks-{}", std::process::id()));
        std::fs::write(&path, &bytes).unwrap();
        let file = File::open(&path).unwrap();
        let mut archive = IndexedArchive {
            scope: String::new(),
            modified: file.metadata().unwrap().modified().unwrap(),
            size: bytes.len() as u64,
            file,
            programs: vec![Program {
                key: Vec::new(),
                record: Record {
                    start: 250_003,
                    len: 450_000,
                    checksum: 0,
                },
            }],
            program_range: 101..700_003,
            program_chunks: HashMap::new(),
            ids: HashMap::new(),
            groups: HashMap::new(),
            loaded: HashMap::new(),
            failures: 0,
            bytes_read: 0,
        };
        let mut output = vec![17, 23];
        archive.append_program(0, &mut output).unwrap();
        assert_eq!(&output[2..], &bytes[250_003..700_003]);
        assert_eq!(archive.bytes_read, 699_902);
        let read = archive.bytes_read;
        archive.append_program(0, &mut output).unwrap();
        assert_eq!(archive.bytes_read, read);
        assert_eq!(&output[450_002..], &bytes[250_003..700_003]);
        drop(archive);
        std::fs::remove_file(path).unwrap();
    }

    #[test]
    fn subset_binding_record_validation_and_file_changes_preserve_fallback() {
        static NEXT: AtomicUsize = AtomicUsize::new(0);
        let raw = crate::parse_raw_grammar(
            r#"{
            "scopeName":"source.indexed",
            "patterns":[
                {"match":"outer"},
                {"begin":"<", "end":">", "patterns":[{"match":"inner"}]},
                {"begin":"\\[", "end":"\\]", "patterns":[{"match":"rare"}]}
            ]
        }"#,
            Some("indexed.json"),
        )
        .unwrap();
        let mut bytes = crate::decompress_precompiled_patterns(
            &crate::precompile_grammar_patterns(&raw).unwrap(),
        )
        .unwrap();
        let index = index_precompiled_patterns(&bytes).unwrap();
        let path = std::env::temp_dir().join(format!(
            "ferriki-indexed-record-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        std::fs::write(&path, &bytes).unwrap();
        let mut source = IndexedArchive::open(File::open(&path).unwrap(), &index).unwrap();
        let lists: Vec<Vec<String>> = source
            .groups
            .keys()
            .map(|ids| {
                ids.iter()
                    .map(|id| {
                        pattern_key(&source.programs[*id as usize].key)
                            .unwrap()
                            .0
                            .to_owned()
                    })
                    .collect()
            })
            .collect();
        for patterns in &lists {
            source
                .load(&patterns.iter().map(String::as_str).collect::<Vec<_>>())
                .unwrap()
                .validate_groups()
                .unwrap();
        }
        let rare_ids = source
            .groups
            .keys()
            .find(|ids| {
                ids.iter()
                    .any(|id| pattern_key(&source.programs[*id as usize].key).unwrap().0 == "rare")
            })
            .unwrap();
        let bad = &source.groups[rare_ids];
        bytes[bad.start as usize + bad.len as usize - 1] ^= 1;
        drop(source);
        std::fs::write(&path, &bytes).unwrap();
        let mut source = IndexedArchive::open(File::open(&path).unwrap(), &index).unwrap();
        for patterns in &lists {
            let pair = source
                .load(&patterns.iter().map(String::as_str).collect::<Vec<_>>())
                .unwrap();
            assert_eq!(
                pair.validate_groups().is_err(),
                patterns.iter().any(|p| p == "rare")
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
        assert!(source.load(&patterns).is_none());
        assert_eq!(source.bytes_read, 0);
        assert_eq!(source.stats().1, 1);
        assert!(source.load(&patterns).is_none());
        assert_eq!(source.stats().1, 1);
        drop(source);
        let mut invalid_index = Index::decode(&index).unwrap();
        invalid_index.programs[0].record.start = u64::MAX;
        assert!(
            IndexedArchive::open(File::open(&path).unwrap(), &invalid_index.encode().unwrap())
                .is_err()
        );
        std::fs::remove_file(path).unwrap();
    }
}
