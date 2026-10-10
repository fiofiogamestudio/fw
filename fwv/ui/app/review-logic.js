(function () {
  'use strict';
  const status = row => ({ unreviewed: 'skipped', issue: 'rejected' }[row.reviewStatus] || row.reviewStatus || 'skipped');
  const ordered = rows => rows.filter(row => !row.historical).slice().sort((a, b) => a.number - b.number);
  const resolved = row => ['accepted', 'rejected'].includes(status(row));
  function nextPending(rows, currentId) {
    const candidates = ordered(rows), start = candidates.findIndex(row => row.id === currentId);
    for (let offset = 1; offset <= candidates.length; offset++) {
      const row = candidates[(start + offset + candidates.length) % candidates.length];
      if (!resolved(row)) return row;
    }
    return null;
  }
  const issues = rows => ordered(rows).filter(row => status(row) !== 'accepted'
    && (status(row) === 'rejected' || ['risk', 'error'].includes(row.autoCheck?.status || row.autoCheckStatus || 'risk')));
  function issue(data, row) {
    return {
      schemaVersion: 1, project: data.project, runId: data.run?.id, manifestId: data.manifestId,
      id: row.id, number: row.number, title: row.title, module: row.category,
      image: { path: row.sourcePath || row.path, width: row.width, height: row.height, sha256: row.sha256 },
      autoCheck: row.autoCheck || { status: 'risk', summary: '尚未进行自动检查；此状态不代表安全。' },
      review: { status: status(row), note: row.reviewNote || '' },
      evidence: row.evidence || '', notes: row.notes || '', state: row.state || {}
    };
  }
  function exportQueue(data, storage) {
    const manifestId = typeof data?.manifestId === 'string' ? data.manifestId : '';
    const storageKey = `fwv-ui-export-queue:v1:${manifestId}`;
    let cleared = new Map();
    // This acknowledgement is independent of review decisions and immutable capture data.
    try {
      const raw = manifestId && storage?.getItem(storageKey);
      if (typeof raw === 'string') {
        const saved = JSON.parse(raw);
        if (saved && Object.keys(saved).length === 3 && saved.schemaVersion === 1
          && saved.manifestId === manifestId && Array.isArray(saved.cleared)
          && saved.cleared.every(entry => Array.isArray(entry) && entry.length === 2
            && typeof entry[0] === 'string' && typeof entry[1] === 'string')) {
          cleared = new Map(saved.cleared);
        }
      }
    } catch { /* Unavailable or malformed storage must not disable the session queue. */ }
    const fingerprint = row => JSON.stringify(issue(data, row));
    const pending = rows => issues(rows).filter(row => cleared.get(row.id) !== fingerprint(row));
    function persist() {
      try {
        if (!manifestId || !storage) return false;
        storage.setItem(storageKey, JSON.stringify({ schemaVersion: 1, manifestId, cleared: Array.from(cleared) }));
        return true;
      } catch { return false; }
    }
    return Object.freeze({
      pending,
      clear(rows) {
        const problems = pending(rows);
        for (const row of problems) cleared.set(row.id, fingerprint(row));
        return { count: problems.length, persisted: persist() };
      },
      restore() {
        const count = cleared.size;
        cleared.clear();
        return { count, persisted: persist() };
      },
      hasCleared: () => cleared.size > 0
    });
  }
  window.fwvUiReview = Object.freeze({ status, ordered, resolved, nextPending, issues, issue, exportQueue });
}());
