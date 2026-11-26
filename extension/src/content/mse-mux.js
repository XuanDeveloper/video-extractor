// Remuxador sem recodificacao: le os pedacos que o player entregou ao MediaSource
// (MP4 fragmentado e/ou WebM, por faixa) e gera UM arquivo WebM/Matroska com
// video + audio. Roda no mundo da pagina (world: MAIN) e tambem em Node (testes).
//
// Equivalente a: ffmpeg -i video.mp4 -i audio.webm -c copy saida.mkv

(function (root) {
  'use strict';

  // ------------------------------------------------------------ bytes

  const u16 = (b, o) => (b[o] << 8) | b[o + 1];
  const u32 = (b, o) => ((b[o] << 24) >>> 0) + (b[o + 1] << 16) + (b[o + 2] << 8) + b[o + 3];
  const i32 = (b, o) => (b[o] << 24) | (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3];
  const u64 = (b, o) => u32(b, o) * 4294967296 + u32(b, o + 4);
  const i64 = (b, o) => i32(b, o) * 4294967296 + u32(b, o + 4);
  const str4 = (b, o) => String.fromCharCode(b[o], b[o + 1], b[o + 2], b[o + 3]);

  const isMp4 = (b) => b.length >= 8 && ['ftyp', 'moov', 'styp', 'moof'].includes(str4(b, 4));
  const isWebm = (b) => b.length >= 4 && b[0] === 0x1a && b[1] === 0x45 && b[2] === 0xdf && b[3] === 0xa3;

  // ============================================================== MP4

  function* boxes(b, start, end) {
    let o = start;
    end = Math.min(end, b.length);
    while (o + 8 <= end) {
      let size = u32(b, o);
      const type = str4(b, o + 4);
      let header = 8;
      if (size === 1) {
        if (o + 16 > end) return;
        size = u64(b, o + 8);
        header = 16;
      } else if (size === 0) {
        size = b.length - o;
      }
      if (size < header) return;
      yield { type, start: o, end: o + size, data: o + header, complete: o + size <= b.length };
      o += size;
    }
  }

  const child = (b, box, type) => {
    if (!box) return null;
    for (const c of boxes(b, box.data, box.end)) if (c.type === type) return c;
    return null;
  };
  const kids = (b, box, type) => {
    const out = [];
    if (!box) return out;
    for (const c of boxes(b, box.data, box.end)) if (c.type === type) out.push(c);
    return out;
  };
  const path = (b, box, ...types) => types.reduce((acc, t) => child(b, acc, t), box);

  function readDescriptor(b, o) {
    const tag = b[o++];
    let size = 0;
    for (let i = 0; i < 4; i++) {
      const x = b[o++];
      size = (size << 7) | (x & 0x7f);
      if (!(x & 0x80)) break;
    }
    return { tag, size, o };
  }

  /** AudioSpecificConfig de dentro do esds. */
  function aacConfig(esds) {
    if (!esds) return null;
    let d = readDescriptor(esds, 4);
    if (d.tag === 0x03) {
      let o = d.o + 2;
      const flags = esds[o++];
      if (flags & 0x80) o += 2;
      if (flags & 0x40) o += 1 + esds[o];
      if (flags & 0x20) o += 2;
      d = readDescriptor(esds, o);
    }
    if (d.tag === 0x04) d = readDescriptor(esds, d.o + 13);
    return d.tag === 0x05 ? esds.slice(d.o, d.o + d.size) : null;
  }

  /** dOps (MP4, big-endian) -> OpusHead (Matroska, little-endian). */
  function opusHeadFromDOps(d) {
    const channels = d[1];
    const preSkip = u16(d, 2);
    const rate = u32(d, 4);
    const gain = (d[8] << 8) | d[9];
    const family = d[10];
    const extra = family ? d.subarray(11) : new Uint8Array(0);
    const out = new Uint8Array(19 + extra.length);
    out.set([0x4f, 0x70, 0x75, 0x73, 0x48, 0x65, 0x61, 0x64]); // "OpusHead"
    out[8] = 1;
    out[9] = channels;
    out[10] = preSkip & 0xff;
    out[11] = preSkip >> 8;
    out[12] = rate & 0xff;
    out[13] = (rate >> 8) & 0xff;
    out[14] = (rate >> 16) & 0xff;
    out[15] = (rate >>> 24) & 0xff;
    out[16] = gain & 0xff;
    out[17] = (gain >> 8) & 0xff;
    out[18] = family;
    out.set(extra, 19);
    return { head: out, preSkip };
  }

  function codecFromMp4(fmt, cfg) {
    switch (fmt) {
      case 'avc1':
      case 'avc3':
        return { codecId: 'V_MPEG4/ISO/AVC', priv: cfg.avcC, inband: false };
      case 'hvc1':
      case 'hev1':
        return { codecId: 'V_MPEGH/ISO/HEVC', priv: cfg.hvcC, inband: false };
      case 'av01':
        return { codecId: 'V_AV1', priv: cfg.av1C, inband: true };
      case 'vp09':
        return { codecId: 'V_VP9', priv: null, inband: true };
      case 'vp08':
        return { codecId: 'V_VP8', priv: null, inband: true };
      case 'mp4a':
        return { codecId: 'A_AAC', priv: aacConfig(cfg.esds) };
      case 'Opus': {
        if (!cfg.dOps) return { codecId: 'A_OPUS', priv: null };
        const { head, preSkip } = opusHeadFromDOps(cfg.dOps);
        return { codecId: 'A_OPUS', priv: head, codecDelayNs: Math.round((preSkip / 48000) * 1e9) };
      }
      case 'ec-3':
        return { codecId: 'A_EAC3', priv: null };
      case 'ac-3':
        return { codecId: 'A_AC3', priv: null };
      case 'encv':
      case 'enca':
        throw new Error('Faixa criptografada (DRM): nao e possivel remuxar');
      default:
        throw new Error(`Codec MP4 nao suportado: ${fmt}`);
    }
  }

  function parseMoov(b, moov) {
    const tracks = new Map();
    for (const trak of kids(b, moov, 'trak')) {
      const tkhd = child(b, trak, 'tkhd');
      const mdia = child(b, trak, 'mdia');
      const mdhd = child(b, mdia, 'mdhd');
      const hdlr = child(b, mdia, 'hdlr');
      const stsd = path(b, mdia, 'minf', 'stbl', 'stsd');
      if (!tkhd || !mdhd || !hdlr || !stsd) continue;

      const trackId = u32(b, tkhd.data + (b[tkhd.data] === 1 ? 20 : 12));
      const timescale = u32(b, mdhd.data + (b[mdhd.data] === 1 ? 20 : 12));
      const handler = str4(b, hdlr.data + 8);
      if (handler !== 'vide' && handler !== 'soun') continue;

      const entry = boxes(b, stsd.data + 8, stsd.end).next().value;
      if (!entry) continue;
      const c = entry.data;
      const info = { trackId, timescale, type: handler === 'vide' ? 'video' : 'audio', shift: 0 };
      let childStart;
      if (info.type === 'video') {
        info.width = u16(b, c + 24);
        info.height = u16(b, c + 26);
        childStart = c + 78;
      } else {
        const ver = u16(b, c + 8);
        info.channels = u16(b, c + 16);
        info.rate = u32(b, c + 24) >>> 16;
        childStart = c + 28 + (ver === 1 ? 16 : ver === 2 ? 36 : 0);
      }
      const cfg = {};
      for (const cb of boxes(b, childStart, entry.end)) cfg[cb.type] = b.slice(cb.data, cb.end);
      Object.assign(info, codecFromMp4(entry.type, cfg));
      if (info.type === 'audio' && info.codecId === 'A_OPUS') info.rate = 48000;

      // Edit list: desloca o PTS (comum em H.264 com B-frames).
      const elst = path(b, trak, 'edts', 'elst');
      if (elst) {
        const v = b[elst.data];
        const count = u32(b, elst.data + 4);
        let p = elst.data + 8;
        for (let i = 0; i < count; i++) {
          const mediaTime = v === 1 ? i64(b, p + 8) : i32(b, p + 4);
          p += v === 1 ? 20 : 12;
          if (mediaTime >= 0) {
            info.shift = mediaTime / timescale;
            break;
          }
        }
      }
      tracks.set(trackId, info);
    }

    const trex = new Map();
    for (const t of kids(b, child(b, moov, 'mvex'), 'trex')) {
      const p = t.data + 4;
      trex.set(u32(b, p), { dur: u32(b, p + 8), size: u32(b, p + 12), flags: u32(b, p + 16) });
    }
    return { tracks, trex };
  }

  function parseMoof(b, moof, ctx, offset, out) {
    for (const traf of kids(b, moof, 'traf')) {
      const tfhd = child(b, traf, 'tfhd');
      if (!tfhd) continue;
      const fl = (b[tfhd.data + 1] << 16) | (b[tfhd.data + 2] << 8) | b[tfhd.data + 3];
      let p = tfhd.data + 4;
      const trackId = u32(b, p);
      p += 4;
      const info = ctx.tracks.get(trackId);
      if (!info) continue;
      const tx = ctx.trex.get(trackId) || {};
      if (fl & 0x01) p += 8; // base_data_offset absoluto: ignorado (base = moof)
      if (fl & 0x02) p += 4;
      let defDur = tx.dur || 0;
      let defSize = tx.size || 0;
      let defFlags = tx.flags || 0;
      if (fl & 0x08) (defDur = u32(b, p)), (p += 4);
      if (fl & 0x10) (defSize = u32(b, p)), (p += 4);
      if (fl & 0x20) (defFlags = u32(b, p)), (p += 4);

      const tfdt = child(b, traf, 'tfdt');
      let dts = tfdt ? (b[tfdt.data] === 1 ? u64(b, tfdt.data + 4) : u32(b, tfdt.data + 4)) : 0;

      // Sem data_offset: dados comecam no mdat logo apos o moof.
      let dataPos = null;
      for (const trun of kids(b, traf, 'trun')) {
        const v = b[trun.data];
        const tf = (b[trun.data + 1] << 16) | (b[trun.data + 2] << 8) | b[trun.data + 3];
        let q = trun.data + 4;
        const count = u32(b, q);
        q += 4;
        if (tf & 0x01) {
          dataPos = moof.start + i32(b, q);
          q += 4;
        } else if (dataPos == null) {
          dataPos = moof.end + 8;
        }
        let firstFlags = null;
        if (tf & 0x04) (firstFlags = u32(b, q)), (q += 4);

        for (let i = 0; i < count; i++) {
          let dur = defDur;
          let size = defSize;
          let flags = i === 0 && firstFlags != null ? firstFlags : defFlags;
          let cto = 0;
          if (tf & 0x100) (dur = u32(b, q)), (q += 4);
          if (tf & 0x200) (size = u32(b, q)), (q += 4);
          if (tf & 0x400) {
            const f = u32(b, q);
            q += 4;
            if (!(i === 0 && firstFlags != null)) flags = f;
          }
          if (tf & 0x800) (cto = v === 1 ? i32(b, q) : u32(b, q)), (q += 4);

          if (dataPos + size > b.length) return; // fragmento incompleto
          const key = info.type === 'audio' || !(flags & 0x10000);
          out.push({
            dts: dts / info.timescale + offset - info.shift,
            pts: (dts + cto) / info.timescale + offset - info.shift,
            dur: dur / info.timescale,
            key,
            lacing: 0,
            data: b.subarray(dataPos, dataPos + size),
          });
          dataPos += size;
          dts += dur;
        }
      }
    }
  }

  function demuxMp4(b, offset) {
    let ctx = null;
    const samples = [];
    for (const box of boxes(b, 0, b.length)) {
      if (!box.complete) break;
      if (box.type === 'moov') ctx = parseMoov(b, box);
      else if (box.type === 'moof' && ctx) parseMoof(b, box, ctx, offset, samples);
    }
    if (!ctx || !ctx.tracks.size) return null;
    // Uma faixa por SourceBuffer: fica com a primeira.
    const info = ctx.tracks.values().next().value;
    return { info, samples };
  }

  // ============================================================= WebM

  const ID = {
    EBML: 0x1a45dfa3, Segment: 0x18538067, Info: 0x1549a966, TimecodeScale: 0x2ad7b1,
    Duration: 0x4489, Tracks: 0x1654ae6b, TrackEntry: 0xae, TrackNumber: 0xd7,
    TrackType: 0x83, CodecID: 0x86, CodecPrivate: 0x63a2, CodecDelay: 0x56aa,
    SeekPreRoll: 0x56bb, Video: 0xe0, PixelWidth: 0xb0, PixelHeight: 0xba, Audio: 0xe1,
    SamplingFrequency: 0xb5, Channels: 0x9f, ContentEncodings: 0x6d80, Cluster: 0x1f43b675,
    Timecode: 0xe7, SimpleBlock: 0xa3, BlockGroup: 0xa0, Block: 0xa1, ReferenceBlock: 0xfb,
    Cues: 0x1c53bb6b, SeekHead: 0x114d9b74, Tags: 0x1254c367, Chapters: 0x1043a770,
    Attachments: 0x1941a469, Void: 0xec,
  };
  const LEVEL1 = new Set([ID.Info, ID.Tracks, ID.Cluster, ID.Cues, ID.SeekHead, ID.Tags, ID.Chapters, ID.Attachments]);

  function readId(b, o) {
    const first = b[o];
    if (first === undefined) return null;
    let len = 1;
    let mask = 0x80;
    while (len <= 4 && !(first & mask)) (len++), (mask >>= 1);
    if (len > 4 || o + len > b.length) return null;
    let id = 0;
    for (let i = 0; i < len; i++) id = id * 256 + b[o + i];
    return { id, len };
  }

  function readSize(b, o) {
    const first = b[o];
    if (first === undefined) return null;
    let len = 1;
    let mask = 0x80;
    while (len <= 8 && !(first & mask)) (len++), (mask >>= 1);
    if (len > 8 || o + len > b.length) return null;
    let val = first & (mask - 1);
    let allOnes = val === mask - 1;
    for (let i = 1; i < len; i++) {
      val = val * 256 + b[o + i];
      if (b[o + i] !== 0xff) allOnes = false;
    }
    return { val, len, unknown: allOnes };
  }

  function readEl(b, o) {
    const id = readId(b, o);
    if (!id) return null;
    const size = readSize(b, o + id.len);
    if (!size) return null;
    const data = o + id.len + size.len;
    return { id: id.id, data, end: size.unknown ? null : data + size.val, unknown: size.unknown };
  }

  function readUint(b, s, e) {
    let v = 0;
    for (let i = s; i < e; i++) v = v * 256 + b[i];
    return v;
  }

  function readFloat(b, s, e) {
    const dv = new DataView(b.buffer, b.byteOffset + s, e - s);
    return e - s === 4 ? dv.getFloat32(0) : dv.getFloat64(0);
  }

  function* elements(b, start, end) {
    let o = start;
    while (o < end) {
      const el = readEl(b, o);
      if (!el || el.end == null || el.end > b.length) return;
      yield el;
      o = el.end;
    }
  }

  function parseTracks(b, tracksEl, tracks) {
    for (const te of elements(b, tracksEl.data, tracksEl.end)) {
      if (te.id !== ID.TrackEntry) continue;
      const t = { codecDelayNs: 0 };
      for (const f of elements(b, te.data, te.end)) {
        if (f.id === ID.TrackNumber) t.number = readUint(b, f.data, f.end);
        else if (f.id === ID.TrackType) t.type = readUint(b, f.data, f.end) === 1 ? 'video' : 'audio';
        else if (f.id === ID.CodecID) t.codecId = String.fromCharCode(...b.subarray(f.data, f.end));
        else if (f.id === ID.CodecPrivate) t.priv = b.slice(f.data, f.end);
        else if (f.id === ID.CodecDelay) t.codecDelayNs = readUint(b, f.data, f.end);
        else if (f.id === ID.ContentEncodings) t.encrypted = true;
        else if (f.id === ID.Video) {
          for (const v of elements(b, f.data, f.end)) {
            if (v.id === ID.PixelWidth) t.width = readUint(b, v.data, v.end);
            if (v.id === ID.PixelHeight) t.height = readUint(b, v.data, v.end);
          }
        } else if (f.id === ID.Audio) {
          for (const a of elements(b, f.data, f.end)) {
            if (a.id === ID.SamplingFrequency) t.rate = readFloat(b, a.data, a.end);
            if (a.id === ID.Channels) t.channels = readUint(b, a.data, a.end);
          }
        }
      }
      if (t.encrypted) throw new Error('Faixa criptografada (DRM): nao e possivel remuxar');
      t.inband = /^V_(VP8|VP9|AV1)$/.test(t.codecId || '');
      tracks.set(t.number, t);
    }
  }

  function pushBlock(b, s, e, clusterTc, scale, offset, keyHint, out, trackNo) {
    const tn = readSize(b, s);
    if (!tn || tn.val !== trackNo) return;
    const p = s + tn.len;
    const rel = (b[p] << 24) >> 16 | b[p + 1]; // int16
    const flags = b[p + 2];
    const t = ((clusterTc + rel) * scale) / 1e9 + offset;
    out.push({
      dts: t,
      pts: t,
      dur: 0,
      key: keyHint == null ? Boolean(flags & 0x80) : keyHint,
      lacing: flags & 0x06,
      data: b.subarray(p + 3, e),
    });
  }

  function demuxWebm(b, offset) {
    let scale = 1e6;
    const tracks = new Map();
    const samples = [];
    let track = null;
    let o = 0;

    const parseCluster = (start, end) => {
      let tc = 0;
      let q = start;
      while (q < end) {
        const el = readEl(b, q);
        if (!el) return q;
        if (el.unknown || LEVEL1.has(el.id) || el.end > b.length) {
          // cluster de tamanho desconhecido termina no proximo elemento de nivel 1
          return LEVEL1.has(el.id) ? q : b.length;
        }
        if (el.id === ID.Timecode) tc = readUint(b, el.data, el.end);
        else if (el.id === ID.SimpleBlock && track) pushBlock(b, el.data, el.end, tc, scale, offset, null, samples, track.number);
        else if (el.id === ID.BlockGroup && track) {
          let block = null;
          let hasRef = false;
          for (const g of elements(b, el.data, el.end)) {
            if (g.id === ID.Block) block = g;
            if (g.id === ID.ReferenceBlock) hasRef = true;
          }
          if (block) pushBlock(b, block.data, block.end, tc, scale, offset, !hasRef, samples, track.number);
        }
        q = el.end;
      }
      return q;
    };

    while (o < b.length) {
      const el = readEl(b, o);
      if (!el) break;
      if (el.id === ID.EBML) {
        o = el.end;
      } else if (el.id === ID.Segment) {
        o = el.data; // desce
      } else if (el.id === ID.Info && el.end <= b.length) {
        for (const f of elements(b, el.data, el.end)) {
          if (f.id === ID.TimecodeScale) scale = readUint(b, f.data, f.end);
        }
        o = el.end;
      } else if (el.id === ID.Tracks && el.end <= b.length) {
        parseTracks(b, el, tracks);
        track = tracks.values().next().value || null;
        o = el.end;
      } else if (el.id === ID.Cluster) {
        const end = el.unknown ? b.length : Math.min(el.end, b.length);
        o = parseCluster(el.data, end);
        if (!el.unknown && el.end <= b.length) o = el.end;
      } else if (el.unknown || el.end > b.length) {
        break;
      } else {
        o = el.end;
      }
    }
    if (!track) return null;
    return { info: track, samples };
  }

  // ==================================================== selecao/fusao

  function demuxPart(bytes, offset) {
    if (isMp4(bytes)) return demuxMp4(bytes, offset);
    if (isWebm(bytes)) return demuxWebm(bytes, offset);
    return null;
  }

  /** Divide em GOPs (keyframe + dependentes) para fundir sem quebrar a decodificacao. */
  function toGops(samples, isVideo) {
    const sorted = samples.slice().sort((a, b) => a.dts - b.dts);
    // WebM nao informa a duracao de cada quadro: estima pelo proximo.
    for (let i = 0; i < sorted.length; i++) {
      if (sorted[i].dur) continue;
      const next = sorted[i + 1];
      const prev = sorted[i - 1];
      sorted[i].dur = next ? Math.max(0, next.dts - sorted[i].dts) : prev ? prev.dur : 0.02;
    }
    if (!isVideo) return sorted.map((s) => ({ start: s.dts, end: s.dts + (s.dur || 0.001), samples: [s] }));
    const gops = [];
    let cur = null;
    for (const s of sorted) {
      if (s.key) {
        cur = { start: s.dts, end: s.dts, samples: [] };
        gops.push(cur);
      }
      if (!cur) continue; // descarta quadros antes do primeiro keyframe
      cur.samples.push(s);
      cur.end = Math.max(cur.end, s.dts + (s.dur || 0.001));
    }
    return gops;
  }

  /** Junta GOPs por ordem de tempo, descartando trechos repetidos (re-downloads, seeks). */
  function mergeGops(gops) {
    gops.sort((a, b) => a.start - b.start);
    const out = [];
    let lastEnd = -Infinity;
    let covered = 0;
    let gaps = 0;
    for (const g of gops) {
      if (g.start < lastEnd - 0.0005) continue;
      if (out.length && g.start - lastEnd > 0.5) gaps++;
      out.push(...g.samples);
      covered += g.end - g.start;
      lastEnd = g.end;
    }
    return { samples: out, covered, gaps };
  }

  /**
   * @param {{runs: {parts: {bytes: Uint8Array, offset: number}[]}[]}} capture  uma faixa (SourceBuffer)
   */
  function buildTrack(capture) {
    const runs = [];
    for (const run of capture.runs) {
      let info = null;
      const parts = []; // amostras separadas por parte: partes podem repetir o mesmo trecho
      for (const part of run.parts) {
        const r = demuxPart(part.bytes, part.offset || 0);
        if (!r) continue;
        info = info || r.info;
        if (r.samples.length) parts.push(r.samples);
      }
      if (info && parts.length) runs.push({ info, parts, samples: parts.flat() });
    }
    if (!runs.length) return null;

    const isVideo = runs[0].info.type === 'video';
    const sameCodec = runs.every((r) => r.info.codecId === runs[0].info.codecId);
    let candidates;
    if (isVideo && sameCodec && runs[0].info.inband) {
      // AV1/VP8/VP9 carregam os parametros no proprio quadro: trocas de qualidade podem ser fundidas.
      candidates = runs;
    } else {
      // Fica com a qualidade que cobre mais tempo.
      const span = (r) => {
        const ts = r.samples.map((s) => s.dts);
        return Math.max(...ts) - Math.min(...ts);
      };
      candidates = [runs.reduce((best, r) => (span(r) > span(best) ? r : best))];
    }

    const merged = mergeGops(candidates.flatMap((r) => r.parts.flatMap((p) => toGops(p, isVideo))));
    const info = { ...candidates[0].info };
    if (isVideo) {
      info.width = Math.max(...candidates.map((r) => r.info.width || 0));
      info.height = Math.max(...candidates.map((r) => r.info.height || 0));
    }
    return { info, samples: merged.samples, covered: merged.covered, gaps: merged.gaps };
  }

  // ======================================================= escrita MKV

  const enc = new TextEncoder();

  function sizeVint(n) {
    // Tamanho sempre em 8 bytes: simplifica o calculo de posicoes.
    const out = new Uint8Array(8);
    out[0] = 0x01;
    let v = n;
    for (let i = 7; i >= 1; i--) {
      out[i] = v % 256;
      v = Math.floor(v / 256);
    }
    return out;
  }

  function idBytes(id) {
    const out = [];
    let v = id;
    while (v > 0) {
      out.unshift(v & 0xff);
      v = Math.floor(v / 256);
    }
    return Uint8Array.from(out);
  }

  function uintBytes(n, fixed = 0) {
    const out = [];
    let v = Math.max(0, Math.round(n));
    do {
      out.unshift(v % 256);
      v = Math.floor(v / 256);
    } while (v > 0);
    while (out.length < fixed) out.unshift(0);
    return Uint8Array.from(out);
  }

  function floatBytes(f) {
    const out = new Uint8Array(8);
    new DataView(out.buffer).setFloat64(0, f);
    return out;
  }

  /** No: {id, kids:[...]} ou {id, data:Uint8Array}. Tamanho calculado sob demanda. */
  const el = (id, content) => (Array.isArray(content) ? { id, kids: content } : { id, data: content });
  const elUint = (id, n, fixed) => el(id, uintBytes(n, fixed));
  const elStr = (id, s) => el(id, enc.encode(s));
  const elFloat = (id, f) => el(id, floatBytes(f));

  function bodySize(node) {
    if (node._size != null) return node._size;
    let size = 0;
    if (node.kids) for (const k of node.kids) size += totalSize(k);
    else if (node.parts) for (const p of node.parts) size += p.length;
    else size = node.data.length;
    node._size = size;
    return size;
  }
  const totalSize = (node) => idBytes(node.id).length + 8 + bodySize(node);

  function serialize(node, out) {
    out.push(idBytes(node.id), sizeVint(bodySize(node)));
    if (node.kids) for (const k of node.kids) serialize(k, out);
    else if (node.parts) out.push(...node.parts);
    else out.push(node.data);
  }

  function simpleBlock(trackNo, rel, flags, data) {
    const head = new Uint8Array(4);
    head[0] = 0x80 | trackNo;
    head[1] = (rel >> 8) & 0xff;
    head[2] = rel & 0xff;
    head[3] = flags;
    return { id: ID.SimpleBlock, parts: [head, data] };
  }

  const WEBM_CODECS = new Set(['V_VP8', 'V_VP9', 'V_AV1', 'A_OPUS', 'A_VORBIS']);

  function trackEntry(no, info) {
    const fields = [
      elUint(ID.TrackNumber, no),
      elUint(0x73c5, no), // TrackUID
      elUint(ID.TrackType, info.type === 'video' ? 1 : 2),
      elUint(0x9c, 0), // FlagLacing
      elStr(ID.CodecID, info.codecId),
    ];
    if (info.priv && info.priv.length) fields.push(el(ID.CodecPrivate, info.priv));
    if (info.codecId === 'A_OPUS') {
      fields.push(elUint(ID.CodecDelay, info.codecDelayNs || 6500000));
      fields.push(elUint(ID.SeekPreRoll, 80000000));
    }
    if (info.type === 'video') {
      fields.push(el(ID.Video, [elUint(ID.PixelWidth, info.width || 0), elUint(ID.PixelHeight, info.height || 0)]));
    } else {
      fields.push(el(ID.Audio, [elFloat(ID.SamplingFrequency, info.rate || 48000), elUint(ID.Channels, info.channels || 2)]));
    }
    return el(ID.TrackEntry, fields);
  }

  /**
   * @param {Array<{info, samples}>} tracks  faixas ja demuxadas (video primeiro)
   * @returns {{chunks: Uint8Array[], ext: string, mime: string, duration: number}}
   */
  function writeMatroska(tracks) {
    const usable = tracks.filter((t) => t && t.samples.length);
    if (!usable.length) throw new Error('Nada para gravar');
    usable.sort((a, b) => (a.info.type === 'video' ? -1 : 1) - (b.info.type === 'video' ? -1 : 1));

    // Comeca em zero mantendo a sincronia entre as faixas.
    const t0 = Math.min(...usable.map((t) => Math.min(...t.samples.map((s) => s.pts))));
    const all = [];
    usable.forEach((t, idx) => {
      for (const s of t.samples) all.push({ ...s, track: idx + 1, video: t.info.type === 'video' });
    });
    all.sort((a, b) => a.dts - b.dts || a.track - b.track);

    const hasVideo = usable.some((t) => t.info.type === 'video');
    const clusters = [];
    let cluster = null;
    let maxMs = 0;
    for (const s of all) {
      const ms = Math.round((s.pts - t0) * 1000);
      const dtsMs = Math.round((s.dts - t0) * 1000);
      maxMs = Math.max(maxMs, ms + Math.round((s.dur || 0) * 1000));
      const startNew =
        !cluster ||
        (hasVideo ? s.video && s.key : dtsMs - cluster.tc >= 5000) ||
        ms - cluster.tc > 30000 ||
        ms - cluster.tc < -30000;
      if (startNew) {
        cluster = { tc: Math.max(0, dtsMs), blocks: [], cue: hasVideo ? s.video && s.key : true, cueTrack: s.track };
        clusters.push(cluster);
      }
      const flags = (s.key ? 0x80 : 0) | (s.lacing & 0x06);
      cluster.blocks.push(simpleBlock(s.track, ms - cluster.tc, flags, s.data));
    }

    const clusterNodes = clusters.map((c) => el(ID.Cluster, [elUint(ID.Timecode, c.tc), ...c.blocks]));

    const docType = usable.every((t) => WEBM_CODECS.has(t.info.codecId)) ? 'webm' : 'matroska';
    const info = el(ID.Info, [
      elUint(ID.TimecodeScale, 1000000),
      elStr(0x4d80, 'Video Extractor'),
      elStr(0x5741, 'Video Extractor'),
      elFloat(ID.Duration, maxMs),
    ]);
    const tracksNode = el(ID.Tracks, usable.map((t, i) => trackEntry(i + 1, t.info)));

    // Cues antes dos clusters, com campos de largura fixa: o tamanho e conhecido
    // antes de calcular as posicoes. Sem Cues, o Chrome nao consegue avancar no video.
    const cueClusters = clusters.map((c, i) => ({ c, i })).filter(({ c }) => c.cue);
    const makeCues = (positions) =>
      el(
        ID.Cues,
        cueClusters.map(({ c, i }) =>
          el(0xbb, [
            elUint(0xb3, c.tc, 8),
            el(0xb7, [elUint(0xf7, c.cueTrack), elUint(0xf1, positions[i] || 0, 8)]),
          ])
        )
      );
    const cuesSize = totalSize(makeCues([]));
    let pos = totalSize(info) + totalSize(tracksNode) + cuesSize;
    const positions = clusterNodes.map((n) => {
      const p = pos;
      pos += totalSize(n);
      return p;
    });
    const cues = makeCues(positions);

    const header = el(ID.EBML, [
      elUint(0x4286, 1),
      elUint(0x42f7, 1),
      elUint(0x42f2, 4),
      elUint(0x42f3, 8),
      elStr(0x4282, docType),
      elUint(0x4287, 4),
      elUint(0x4285, 2),
    ]);
    const segment = el(ID.Segment, [info, tracksNode, cues, ...clusterNodes]);

    const chunks = [];
    serialize(header, chunks);
    serialize(segment, chunks);
    return {
      chunks,
      ext: docType === 'webm' ? 'webm' : 'mkv',
      mime: docType === 'webm' ? 'video/webm' : 'video/x-matroska',
      duration: maxMs / 1000,
    };
  }

  /**
   * API principal.
   * @param {Array<{runs}>} captures  uma entrada por SourceBuffer (video, audio)
   */
  function remux(captures) {
    const tracks = [];
    const warnings = [];
    for (const cap of captures) {
      try {
        const t = buildTrack(cap);
        if (t) tracks.push(t);
      } catch (err) {
        warnings.push(String(err.message || err));
      }
    }
    if (!tracks.length) throw new Error(warnings[0] || 'Nao foi possivel interpretar a captura');
    const file = writeMatroska(tracks);
    return {
      ...file,
      warnings,
      tracks: tracks.map((t) => ({
        type: t.info.type,
        codec: t.info.codecId,
        covered: t.covered,
        gaps: t.gaps,
        width: t.info.width,
        height: t.info.height,
      })),
    };
  }

  const api = { remux, demuxPart, writeMatroska, isMp4, isWebm };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else Object.defineProperty(root, '__vepMux', { value: api, configurable: false, enumerable: false });
})(typeof globalThis !== 'undefined' ? globalThis : this);
