// Fila de downloads: estado visivel ao popup + delegacao do trabalho pesado ao offscreen.

import { callOffscreen } from './offscreen.js';
import { uid } from '../lib/utils.js';

const JOBS_KEY = 'vep_jobs';
const MAX_JOBS = 60;

/** @type {Map<string, object>} */
const jobs = new Map();
let loaded = false;
let saveTimer = null;

export async function ensureJobsLoaded() {
  if (loaded) return;
  loaded = true;
  try {
    const data = await chrome.storage.session.get(JOBS_KEY);
    const STALE_MS = 3 * 60 * 1000;
    for (const job of data[JOBS_KEY] || []) {
      // O documento offscreen sobrevive ao desligamento do service worker, entao
      // um job "running" pode continuar vivo. So damos como perdido o que ficou mudo.
      if ((job.status === 'running' || job.status === 'queued') && Date.now() - job.updatedAt > STALE_MS) {
        job.status = 'error';
        job.error = 'Interrompido (sem resposta)';
      }
      jobs.set(job.id, job);
    }
  } catch {
    /* ignora */
  }
}

function save() {
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    const list = [...jobs.values()].slice(-MAX_JOBS);
    chrome.storage.session.set({ [JOBS_KEY]: list }).catch(() => {});
  }, 300);
}

function broadcast(job) {
  chrome.runtime.sendMessage({ target: 'popup', action: 'job.update', payload: job }).catch(() => {});
}

export function listJobs() {
  return [...jobs.values()].sort((a, b) => b.createdAt - a.createdAt);
}

export function activeCount() {
  let n = 0;
  for (const j of jobs.values()) if (j.status === 'running' || j.status === 'queued') n++;
  return n;
}

export function updateJob(id, changes) {
  const job = jobs.get(id);
  if (!job) return null;
  Object.assign(job, changes, { updatedAt: Date.now() });
  save();
  broadcast(job);
  return job;
}

export function clearFinishedJobs() {
  for (const [id, job] of jobs) {
    if (job.status !== 'running' && job.status !== 'queued') jobs.delete(id);
  }
  save();
  chrome.runtime.sendMessage({ target: 'popup', action: 'jobs.refresh' }).catch(() => {});
}

/**
 * @param {object} spec descricao completa do download (ver offscreen/downloader.js)
 */
export async function startJob(spec) {
  await ensureJobsLoaded();
  const id = uid('job');
  const job = {
    id,
    title: spec.filename || 'download',
    kind: spec.type,
    status: 'queued',
    progress: 0,
    stage: 'Na fila',
    received: 0,
    total: spec.expectedSize || 0,
    segmentsDone: 0,
    segmentsTotal: 0,
    error: '',
    sourceUrl: spec.url || spec.manifestUrl || '',
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
  jobs.set(id, job);
  if (jobs.size > MAX_JOBS) {
    const oldestFinished = [...jobs.values()].find((j) => j.status === 'done' || j.status === 'error');
    if (oldestFinished) jobs.delete(oldestFinished.id);
  }
  save();
  broadcast(job);

  try {
    const res = await callOffscreen('download.start', { jobId: id, spec });
    if (!res || !res.ok) {
      updateJob(id, { status: 'error', error: res?.error || 'Falha ao iniciar' });
    }
  } catch (err) {
    updateJob(id, { status: 'error', error: String(err?.message || err) });
  }
  return job;
}

export async function cancelJob(id) {
  const job = jobs.get(id);
  if (!job) return;
  if (job.status === 'done') return;
  updateJob(id, { status: 'canceled', stage: 'Cancelado' });
  try {
    await callOffscreen('download.cancel', { jobId: id });
  } catch {
    /* offscreen pode ja ter morrido */
  }
}

/** Mensagem vinda do offscreen com o andamento. */
export function handleProgress(payload) {
  if (!payload || !payload.jobId) return;
  const job = jobs.get(payload.jobId);
  if (!job) return;
  if (job.status === 'canceled' && payload.status !== 'canceled') return;
  const { jobId, ...changes } = payload;
  updateJob(jobId, changes);
}
