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
  window.fwvUiReview = Object.freeze({ status, ordered, resolved, nextPending, issues, issue });
}());
