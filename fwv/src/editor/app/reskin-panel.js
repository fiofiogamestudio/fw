(function () {
  'use strict';
  const active = attempt => ['queued', 'running', 'waiting-local'].includes(attempt?.status);
  const localAttempt = attempt => attempt?.mode === 'local';
  const cancelledLocally = attempt => localAttempt(attempt) && Boolean(attempt.cancelRequestedAt || attempt.cancelRequested);
  const artifact = (assetId, revisionId, fileName) => '/api/fwv/artifact?' + new URLSearchParams({ assetId, revisionId, fileName });
  const unwrap = result => result?.workflow || result;

  (window.FwvPanels ||= []).push({ id: 'reskin', mount(host, ctx) {
    const ui = ctx.createSurface('reskin'), root = ui.root; host.append(root);
    const statuses = { queued: ui.text('message001'), running: ui.text('message002'), 'waiting-local': ui.text('message003'), ready: ui.text('message004'), succeeded: ui.text('message005'), failed: ui.text('message006'), cancelled: ui.text('message007'), unknown: ui.text('message008') };
    function attemptStatus(attempt) {
      if (attempt?.stage === 'assembling' && active(attempt)) return ui.text('message009');
      if (localAttempt(attempt) && attempt.status === 'queued') return ui.text('message010');
      if (localAttempt(attempt) && attempt.status === 'unknown') return cancelledLocally(attempt) ? ui.text('message011') : ui.text('message012');
      if (attempt?.status === 'waiting-local') return { waiting: ui.text('message003'), claimed: ui.text('message013'), dispatched: ui.text('message014'), completed: ui.text('message009'), cancelled: ui.text('message007') }[attempt.local?.status] || ui.text('message003');
      return statuses[attempt?.status] || attempt?.status || ui.text('message015');
    }
    const { workflows, newPlan, service, status, content } = ui.refs;
    const click = (node, handler) => node?.addEventListener('click', () => { Promise.resolve().then(handler).catch(() => {}); });
    const projectId = ctx.getSnapshot().id, storageKey = `fwv.reskin.pending.v1:${projectId}`, abort = new AbortController();
    const state = { disposed: false, busy: false, initialized: false, polling: false, snapshot: ctx.getSnapshot(), workflows: [], view: null, template: null,
      templateAssetId: ctx.selection?.templateAssetId || '', templateRevisionId: ctx.selection?.templateRevisionId || '', attemptId: '', selected: new Set(), notes: {}, transforms: {}, provider: null, pending: null, unresolved: false, templateToken: 0, templateLoading: false, localRenderKey: '' };
    try { const value = JSON.parse(sessionStorage.getItem(storageKey) || 'null'); if (value?.workflowId && value?.requestId) state.pending = value; } catch {}
    click(newPlan, () => { state.view = null; state.attemptId = ''; pending(null); state.unresolved = false; ctx.setSelection({ workflowId: '', templateAssetId: '', templateRevisionId: '' }); render(); });
    click(service, () => ctx.navigate('generate'));
    let fields = {}, partRows = [], countLabel, resultHost, historyHost, actionHost, localHost, previewHost, characterPreview, adjustmentHost, currentForm, providerLabel;
    function notify(message, error = false) { if (!state.disposed) ui.update({ statusText: message, statusError: error }); }
    function pending(value) { state.pending = value; try { if (value) sessionStorage.setItem(storageKey, JSON.stringify(value)); else sessionStorage.removeItem(storageKey); } catch {} }
    const getAttempt = () => state.view?.attempts?.find(attempt => attempt.id === state.attemptId);
    const getActive = () => state.view?.attempts?.find(active);
    const currentMode = () => fields.mode?.value || state.view?.mode || (state.view ? 'api' : 'local');
    const canGenerate = () => currentMode() === 'local' || Boolean(state.provider?.canGenerate ?? state.provider?.keyConfigured);
    const draftId = () => state.view?.assetId || 'new';
    const getDraft = (id = draftId()) => ctx.drafts.get('reskinDrafts', id);
    function currentDraft() {
      if (!fields.brief) return null;
      return { name: fields.name?.value ?? state.view?.name ?? '', brief: fields.brief.value, style: fields.style.value,
        mode: currentMode(), templateAssetId: state.view?.template?.assetId || state.templateAssetId,
        templateRevisionId: state.view?.template?.revisionId || state.templateRevisionId,
        preserveAlpha: fields.preserveAlpha?.checked ?? state.view?.preserveAlpha ?? true,
        selected: [...state.selected], notes: { ...state.notes }, transforms: structuredClone(state.transforms), attemptId: state.attemptId };
    }
    function saveDraft() { const data = currentDraft(); if (data) ctx.drafts.set('reskinDrafts', draftId(), data); }
    function updateWorkflowList() {
      ui.setOptions(workflows, [{ value: '', label: ui.text('message016') }, ...state.workflows.map(view => ({ value: view.assetId, label: view.name }))], state.view?.assetId || '');
    }
    function partCount() { ui.update({ partCountText: ui.text('message017', { v0: state.selected.size }), callCountText: currentMode() === 'local' ? ui.text('message018', { v0: state.selected.size }) : ui.text('message019', { v0: state.selected.size }) }); sync(); }
    function sync() {
      if (state.disposed) return;
      const blocked = state.busy || Boolean(getActive()) || state.unresolved || !state.view && state.templateLoading;
      const attempt = getAttempt();
      ui.update({ blocked, apiMode: currentMode() === 'api', editorBlocked: blocked || !state.initialized,
        generateBlocked: blocked || !state.selected.size || !canGenerate(), createBlocked: blocked || !state.template || !state.selected.size,
        candidateBlocked: blocked || !attempt?.candidateAssetId || !attempt?.candidateRevisionId,
        assembleBlocked: blocked || !['ready', 'succeeded'].includes(attempt?.status), cancelBlocked: state.busy || !getActive(),
        generateText: currentMode() === 'local' ? ui.text('message020') : ui.text('message021') });
    }
    async function run(fn) { if (state.busy || state.disposed) return; state.busy = true; sync(); try { await fn(); } catch (error) { notify(error.message || ui.text('message022'), true); } finally { state.busy = false; sync(); } }
    async function snapshot() { await ctx.refresh(); if (!state.disposed) state.snapshot = ctx.getSnapshot(); }
    function applyView(value, { force = false } = {}) {
      const view = unwrap(value); if (!view?.assetId) throw new Error(ui.text('message023'));
      const same = state.view?.assetId === view.assetId; state.view = view;
      ctx.setSelection({ workflowId: view.assetId });
      const index = state.workflows.findIndex(item => item.assetId === view.assetId); if (index >= 0) state.workflows[index] = view; else state.workflows.push(view);
      if (!view.attempts?.some(attempt => attempt.id === state.attemptId)) state.attemptId = view.selectedCandidateId || view.attempts?.at(-1)?.id || '';
      let recoveredAttemptId = '';
      if (state.pending?.workflowId === view.assetId) {
        const attempt = view.attempts?.find(item => item.requestId === state.pending.requestId);
        state.unresolved = !attempt;
        if (attempt) { recoveredAttemptId = state.attemptId = attempt.id; if (!active(attempt)) pending(null); }
      }
      updateWorkflowList(); if (!same || force) render({ recoveredAttemptId }); else renderResult(); sync();
      if (recoveredAttemptId && getDraft(view.assetId)?.attemptId !== recoveredAttemptId) saveDraft();
    }
    async function loadWorkflow(id) {
      const response = await ctx.api('/api/fwv/reskin/workflows?' + new URLSearchParams({ workflowId: id }), { signal: abort.signal });
      if (state.disposed) return;
      if (!response.workflow) throw new Error(ui.text('message024'));
      await snapshot(); applyView(response.workflow, { force: state.view?.assetId !== id });
    }
    workflows.addEventListener('change', () => { if (!workflows.value) { state.view = null; state.attemptId = ''; ctx.setSelection({ workflowId: '', templateAssetId: '', templateRevisionId: '' }); render(); } else void run(() => loadWorkflow(workflows.value)); });
    function bindDraftFields(refs, data = {}) {
      fields.brief = refs.brief; fields.style = refs.style; fields.mode = refs.mode;
      fields.brief.value = data.brief || ''; fields.style.value = data.style || ''; fields.mode.value = data.mode || 'local';
      fields.brief.addEventListener('input', saveDraft); fields.style.addEventListener('input', saveDraft);
      function describe() { ui.update({ modeText: fields.mode.value === 'local'
        ? ui.text('message025')
        : ui.text('message026') }); }
      fields.mode.addEventListener('change', () => { describe(); saveDraft(); partCount(); if (state.view) renderResult(); }); describe();
    }
    function partsEditor(parts, { selected, notes } = {}) {
      state.selected = new Set(selected || parts.slice(0, 16).map(part => part.regionName)); state.notes = Object.assign(Object.create(null), notes || {}); partRows = [];
      const card = ui.render('parts', { title: state.view ? ui.text('message027') : ui.text('message028'), description: state.view ? ui.text('message029') : ui.text('message030'), empty: !parts.length });
      const refs = card.refs; countLabel = refs.countLabel;
      click(refs.selectAll, () => { state.selected = new Set(parts.slice(0,16).map(part=>part.regionName)); for(const row of partRows)row.check.checked=state.selected.has(row.part.regionName); saveDraft(); partCount(); });
      click(refs.clear, () => { state.selected.clear(); for(const row of partRows)row.check.checked=false; saveDraft(); partCount(); });
      for (const part of parts) {
        const row = ui.render('part', { regionName:part.regionName, selected:state.selected.has(part.regionName), selectionLabel:ui.text('message031', { v0: part.regionName }),
          description:`${part.width} × ${part.height} px\n${(part.slotNames || []).join(' · ') || (part.boneNames || []).join(' · ') || ui.text('message032')}`, note:state.notes[part.regionName] ?? part.note ?? '' });
        const {check,note}=row.refs; state.notes[part.regionName]=note.value; refs.rows.append(row); partRows.push({part,check,note});
        check.addEventListener('change',()=>{if(check.checked&&state.selected.size>=16){check.checked=false;notify(ui.text('message033'),true);return;}
          if(check.checked)state.selected.add(part.regionName);else state.selected.delete(part.regionName);saveDraft();partCount();});
        note.addEventListener('input',()=>{state.notes[part.regionName]=note.value;saveDraft();});
      }
      return card;
    }
    async function loadTemplate({ resetParts = false, persist = false } = {}) {
      const token = ++state.templateToken; state.template = null; state.templateLoading = true; sync();
      const asset = state.snapshot.assets.find(item => item.id === state.templateAssetId), revision = asset?.revisions.find(item => item.id === state.templateRevisionId);
      if (!asset || !revision) { state.templateLoading = false; sync(); return; }
      characterPreview?.update({ snapshot: state.snapshot, template: { assetId: asset.id, revisionId: revision.id } });
      try {
        const template = await ctx.api('/api/fwv/reskin/template?' + new URLSearchParams({ assetId: asset.id, revisionId: revision.id }), { signal: abort.signal });
        if (state.disposed || token !== state.templateToken || state.view) return; state.template = template.template || template;
        const draft = getDraft('new'), restored = !resetParts && draft?.templateAssetId === asset.id && draft?.templateRevisionId === revision.id ? draft : {};
        const holder = content.querySelector('[data-testid="fwv-reskin-template-parts"]'); holder.replaceChildren(partsEditor(state.template.parts || [], restored));
        ui.update({ templateWarnings: (state.template.warnings || []).map(item => typeof item === 'string' ? item : item.message || item.code).join('\n') }); partCount();
      } catch (error) { if (!state.disposed && token === state.templateToken) notify(error.message, true); }
      finally {
        if (!state.disposed && token === state.templateToken) {
          // Template selection is one edit. Finish its parts before accepting text input.
          if (persist && !state.view) saveDraft();
          state.templateLoading = false; sync();
        }
      }
    }
    function renderCreate() {
      const draft=getDraft('new');state.transforms=draft?.transforms||{};state.attemptId='';state.selected=new Set(draft?.selected||[]);state.notes={...draft?.notes};
      if(draft&&!ctx.selection?.templateAssetId){state.templateAssetId=draft.templateAssetId||'';state.templateRevisionId=draft.templateRevisionId||'';}
      const assets=state.snapshot.assets.filter(asset=>asset.kind==='spine');
      if(!assets.length){const empty=ui.render('empty');click(empty.refs.importTemplate,()=>ctx.navigate('spine'));content.append(empty);return;}
      const layout=ui.render('create'),refs=layout.refs,form=refs.form,assetSelect=refs.templateAssetId,revisionSelect=refs.templateRevisionId,name=refs.name,preserve=refs.preserveAlpha;
      if(window.FwvReskinPreview)characterPreview=window.FwvReskinPreview(refs.previewHost,ctx,{compare:false});
      currentForm=form;fields.name=name;fields.preserveAlpha=preserve;
      ui.setOptions(assetSelect,assets.map(asset=>({value:asset.id,label:asset.name})));
      if(!assets.some(asset=>asset.id===state.templateAssetId))state.templateAssetId=assets[0].id;assetSelect.value=state.templateAssetId;
      function revisions(){const asset=assets.find(item=>item.id===state.templateAssetId);ui.setOptions(revisionSelect,asset.revisions.map((revision,index)=>({value:revision.id,label:`v${index+1}${revision.id===asset.selectedRevisionId?ui.text('message034'):''}`})));
        if(!asset.revisions.some(revision=>revision.id===state.templateRevisionId))state.templateRevisionId=asset.selectedRevisionId;revisionSelect.value=state.templateRevisionId;}
      function changeTemplate(){state.selected.clear();state.notes={};void loadTemplate({resetParts:true,persist:true});}
      revisions();assetSelect.addEventListener('change',()=>{state.templateAssetId=assetSelect.value;state.templateRevisionId='';ctx.setSelection({templateAssetId:'',templateRevisionId:''});revisions();changeTemplate();});
      revisionSelect.addEventListener('change',()=>{state.templateRevisionId=revisionSelect.value;ctx.setSelection({templateAssetId:'',templateRevisionId:''});changeTemplate();});
      name.value=draft?.name||'';name.addEventListener('input',saveDraft);preserve.checked=draft?.preserveAlpha??true;preserve.addEventListener('change',saveDraft);bindDraftFields(refs,draft||{});content.append(layout);
      form.addEventListener('submit',event=>{event.preventDefault();if(!form.reportValidity()||!name.value.trim()||!fields.brief.value.trim()||!state.selected.size)return;void run(async()=>{
        notify(ui.text('message035'));
        const value=await ctx.command('reskin.create',{templateAssetId:state.templateAssetId,templateRevisionId:state.templateRevisionId,name:name.value.trim(),brief:fields.brief.value.trim(),style:fields.style.value.trim(),
          mode:currentMode(),regionNames:[...state.selected],preserveAlpha:preserve.checked,partNotes:Object.fromEntries([...state.selected].map(regionName=>[regionName,state.notes[regionName]||'']))});
        const created=unwrap(value),data=currentDraft();if(data)ctx.drafts.set('reskinDrafts',created.assetId,data);ctx.drafts.remove('reskinDrafts','new');
        await snapshot();applyView(value,{force:true});saveDraft();notify(currentMode()==='local'?ui.text('message036'):ui.text('message037'));
      });});void loadTemplate({resetParts:!draft});
    }
    function renderEditor({recoveredAttemptId=''}={}) {
      const view=state.view,draft=getDraft(view.assetId),templateName=state.snapshot.assets.find(asset=>asset.id===view.template?.assetId)?.name||ui.text('message038');
      const editor=ui.render('editor',{name:view.name,templateLabel:ui.text('message039', { v0: templateName })}),refs=editor.refs;
      previewHost=refs.previewHost;resultHost=refs.resultHost;historyHost=refs.historyHost;providerLabel=refs.providerLabel;localHost=refs.localHost;actionHost=refs.actionHost;adjustmentHost=refs.adjustmentHost;
      if(window.FwvReskinPreview)characterPreview=window.FwvReskinPreview(previewHost,ctx);else previewHost.append(ui.render('previewMissing'));
      refs.partsHost.append(partsEditor(view.parts||[],{selected:draft?.selected,notes:draft?.notes||Object.fromEntries((view.parts||[]).map(part=>[part.regionName,part.note||'']))}));
      bindDraftFields(refs,draft||view);
      click(refs.generate,()=>run(generateAttempt));click(refs.save,()=>run(async()=>{const result=await ctx.command('reskin.update',{workflowId:view.assetId,mode:currentMode(),brief:fields.brief.value.trim(),style:fields.style.value.trim(),partNotes:{...state.notes}});applyView(result);saveDraft();await ctx.drafts.save();notify(ui.text('message040'));}));
      content.append(editor);state.transforms=draft?.transforms||{};
      const restoredAttemptId=recoveredAttemptId||draft?.attemptId;if(restoredAttemptId&&view.attempts?.some(item=>item.id===restoredAttemptId))state.attemptId=restoredAttemptId;
      renderResult();renderAdjustments();partCount();
    }
    function sourceSheet() {
      const attempt = getAttempt();
      return attempt?.guide || state.view.sheet;
    }
    function sheetFrame(label,sheet,testId) {
      const asset=state.snapshot.assets.find(item=>item.id===sheet?.assetId),revision=asset?.revisions.find(item=>item.id===sheet?.revisionId),file=sheet?.fileName||revision?.files.find(item=>item.role==='image'||item.role==='source')?.name;
      const url=sheet?.assetId&&sheet?.revisionId&&file?artifact(sheet.assetId,sheet.revisionId,file):'';
      return ui.render('sheet',{label,testId,url,missing:!url,placeholder:sheet?.assetId?ui.text('message041'):ui.text('message042')});
    }
    function renderLocalTask(attempt) {
      if(!localHost)return;
      const key=JSON.stringify({workflowId:state.view?.assetId,attemptId:attempt?.id,mode:attempt?.mode,status:attempt?.status,cancelled:cancelledLocally(attempt),local:attempt?.local,guide:attempt?.guide?.assetId});
      if(key===state.localRenderKey)return;state.localRenderKey=key;localHost.replaceChildren();if(!localAttempt(attempt))return;
      const analysis=attempt.local?.analysis,actionable=!cancelledLocally(attempt)&&(active(attempt)||attempt.status==='unknown');
      const task=ui.render('local',{workflowId:state.view.assetId,attemptId:attempt.id,actionable,
        description:attempt.status==='waiting-local'&&attempt.local?.status==='waiting'?ui.text('message043'):attemptStatus(attempt)+ui.text('message044'),
        worker:attempt.local?.workerId?ui.text('message045', { v0: attempt.local.workerId }):'',
        instructions:[
          ui.text('message046'),
          ui.text('message047', { v0: ctx.getSession()?.projectRoot||ui.text('message048') }),`workflowId：${state.view.assetId}`,`attemptId：${attempt.id}`,
          ui.text('message049'),
          ui.text('message050'),
          ui.text('message051')
        ].join('\n'),hasAnalysis:Boolean(analysis),summary:analysis?.summary||'',
        partNotes:Object.entries(analysis?.partNotes||{}).map(([regionName,note])=>({message:`${regionName}：${typeof note==='string'?note:JSON.stringify(note)}`})),
        risks:(analysis?.risks||[]).map(risk=>({message:typeof risk==='string'?risk:risk.message||JSON.stringify(risk)}))});
      click(task.refs.copy,async()=>{try{await navigator.clipboard.writeText(task.refs.instructions.value);notify(ui.text('message052'));}
        catch{ui.update({revealInstructions:true},task);task.refs.instructions.focus();task.refs.instructions.select();notify(ui.text('message053'));}});localHost.append(task);
    }
    function renderResult() {
      if(!state.view||!resultHost||state.disposed)return;
      const view=state.view,attempt=getAttempt(),running=getActive(),current=running||attempt;
      characterPreview?.update({snapshot:state.snapshot,template:view.template,candidate:attempt?.candidateAssetId?{assetId:attempt.candidateAssetId,revisionId:attempt.candidateRevisionId}:undefined});
      ui.update({ providerText: currentMode()==='local'?ui.text('message054'):canGenerate()?ui.text('message055', { v0: state.provider?.model||ui.text('message056') }):ui.text('message057') });
      renderLocalTask(current);
      const candidate=state.snapshot.assets.find(asset=>asset.id===attempt?.candidateAssetId)?.revisions.find(revision=>revision.id===attempt?.candidateRevisionId);
      const checks=(candidate?.metadata.reskin?.partChecks||[]).map(check=>({message:ui.text('message058', { v0: check.regionName, v1: check.outputVisiblePixels, v2: check.coverageRatio==null?ui.text('message059'):Math.round(check.coverageRatio*100)+'%' })}));
      if(attempt?.candidateAssetId)checks.push(...(attempt.warnings||[]).filter(warning=>warning.code!=='RESKIN_SOURCE_SILHOUETTE').map(warning=>({message:warning.message||warning.code})));
      const uncertainty=state.unresolved||current?.status==='unknown'?(localAttempt(current)||!current&&currentMode()==='local'
        ?cancelledLocally(current)?ui.text('message060'):ui.text('message061')
        :ui.text('message062')):'';
      ui.update({hasProblem:Boolean(uncertainty || current?.error)});
      const result=ui.render('result',{status:state.unresolved?ui.text('message063'):attemptStatus(current),mode:localAttempt(current)||!current&&currentMode()==='local'?ui.text('message064'):ui.text('message065'),alpha:view.preserveAlpha?ui.text('message066'):ui.text('message067'),error:typeof current?.error==='string'?current.error:current?.error?.message,checks,hasChecks:checks.length>0,uncertainty,prompt:current?.prompt||''});
      result.refs.sourceSheet.append(sheetFrame(attempt?.guide?ui.text('message068'):ui.text('message069'),sourceSheet(),'fwv-reskin-guide'));
      result.refs.generatedSheet.append(sheetFrame(ui.text('message070'),attempt?.sheetAssetId?{assetId:attempt.sheetAssetId,revisionId:attempt.sheetRevisionId}:null,'fwv-reskin-generated-sheet'));
      resultHost.replaceChildren(result);updateProgress();historyHost.replaceChildren();
      for(const [index,entry] of (view.attempts||[]).entries()){
        const selected=view.selectedCandidateId===entry.id||view.selectedCandidateId===entry.candidateAssetId;
        const card=ui.render('attempt',{id:entry.id,selected:String(entry.id===state.attemptId),title:ui.text('message071', { v0: index+1, v1: selected?ui.text('message072'):'' }),status:attemptStatus(entry),description:ui.text('message073', { v0: localAttempt(entry)?ui.text('message064'):ui.text('message065'), v1: entry.regionNames?.length||0, v2: entry.createdAt?'\n'+new Date(entry.createdAt).toLocaleString():'' })});
        click(card,()=>{state.attemptId=entry.id;renderResult();renderAdjustments();saveDraft();});historyHost.append(card);
      }
      if(!view.attempts?.length)historyHost.append(ui.render('historyEmpty'));
      const actions=ui.render('actions',{running:Boolean(running),needsProgress:Boolean(running || state.unresolved || current),candidate:Boolean(attempt?.candidateAssetId)});
      click(actions.refs.cancel,()=>run(async()=>{const result=await ctx.command('reskin.cancel',{workflowId:view.assetId,attemptId:running.id});applyView(result);notify(localAttempt(running)?ui.text('message074'):ui.text('message075'));}));
      click(actions.refs.query,()=>run(()=>loadWorkflow(view.assetId)));
      click(actions.refs.selectCandidate,()=>run(async()=>{const result=await ctx.command('reskin.select',{workflowId:view.assetId,attemptId:attempt.id});applyView(result);notify(ui.text('message076'));}));
      click(actions.refs.open,()=>{saveDraft();ctx.navigate('spine',{assetId:attempt.candidateAssetId,revisionId:attempt.candidateRevisionId});});
      click(actions.refs.export,()=>run(async()=>{const result=await ctx.command('asset.export',{assetId:attempt.candidateAssetId,revisionId:attempt.candidateRevisionId});notify(ui.text('message077', { v0: ctx.getSession()?.projectRoot||'', v1: result.path }));}));
      actionHost.replaceChildren(actions);partCount();
    }
    function renderAdjustments() {
      if(!adjustmentHost)return;adjustmentHost.replaceChildren();const attempt=getAttempt();if(!attempt||!['ready','succeeded'].includes(attempt.status))return;
      const parts=(state.view.parts||[]).filter(part=>attempt.regionNames?.includes(part.regionName));if(!parts.length)return;
      const section=ui.render('adjustments',{recovering:!attempt.candidateAssetId}),refs=section.refs,partSelect=refs.partSelect,flip=refs.flipX,nodes=Object.fromEntries(['scale','offsetX','offsetY','rotation'].map(key=>[key,refs[key]]));
      ui.setOptions(partSelect,parts.map(part=>({value:part.regionName,label:part.regionName})), parts[0].regionName);
      state.transforms[attempt.id]=Object.assign(Object.create(null),state.transforms[attempt.id]||structuredClone(attempt.transforms||{}));const map=state.transforms[attempt.id];
      for(const [key,node]of Object.entries(nodes))node.addEventListener('input',()=>{map[partSelect.value]||={};map[partSelect.value][key]=Number(node.value);saveDraft();});
      flip.addEventListener('change',()=>{map[partSelect.value]||={};map[partSelect.value].flipX=flip.checked;saveDraft();});
      function values(){const value=map[partSelect.value]||{};for(const[key,node]of Object.entries(nodes))node.value=value[key]??(key==='scale'?1:0);flip.checked=Boolean(value.flipX);}
      partSelect.addEventListener('change',values);values();click(refs.assemble,()=>run(async()=>{const result=await ctx.command('reskin.assemble',{workflowId:state.view.assetId,attemptId:attempt.id,transforms:structuredClone(map)});await snapshot();applyView(result);renderAdjustments();saveDraft();notify(ui.text('message078'));}));adjustmentHost.append(section);sync();
    }
    async function generateAttempt() {
      if (!state.view || !state.selected.size || !fields.brief.value.trim()) throw new Error(ui.text('message079'));
      saveDraft(); const requestId = crypto.randomUUID(), workflowId = state.view.assetId, mode = currentMode(); pending({ workflowId, requestId }); state.unresolved = true; sync();
      notify(mode === 'local' ? ui.text('message080', { v0: state.selected.size }) : ui.text('message081', { v0: state.selected.size }));
      try {
        const result = await ctx.command('reskin.generate', { workflowId, requestId, mode, regionNames: [...state.selected], brief: fields.brief.value.trim(), style: fields.style.value.trim(), partNotes: { ...state.notes } });
        await snapshot(); applyView(result); renderAdjustments(); saveDraft(); notify(mode === 'local' ? ui.text('message082') : ui.text('message083'));
      } catch (error) {
        notify(ui.text('message084', { v0: error.message }), true);
        try { await loadWorkflow(workflowId); if (state.unresolved && error.status >= 400 && error.status < 500) { pending(null); state.unresolved = false; notify(ui.text('message085', { v0: error.message }), true); } } catch {}
      }
    }
    function updateProgress() {
      const attempt = getActive() || getAttempt();
      if (!attempt) { ui.update({ progressText: '' }); return; }
      const age = Math.max(0, Math.floor((Date.now() - Date.parse(attempt.createdAt)) / 1000));
      ui.update({ progressText: ui.text('message086', { v0: active(attempt) && Number.isFinite(age) ? ui.text('message087', { v0: Math.floor(age / 60), v1: age % 60 }) : '', v1: attempt.requestId, v2: attempt.regionNames?.length || 0, v3: localAttempt(attempt) ? attempt.local?.dispatchedAt ? ui.text('message088') : ui.text('message089') : ui.text('message090') }) });
    }
    function render({ recoveredAttemptId = '' } = {}) {
      if (state.disposed) return; characterPreview?.dispose(); characterPreview = null; content.replaceChildren(); fields = {}; partRows = []; currentForm = null; state.localRenderKey = ''; resultHost = historyHost = actionHost = localHost = adjustmentHost = providerLabel = null;
      updateWorkflowList(); if (state.view) renderEditor({ recoveredAttemptId }); else renderCreate(); sync();
    }
    async function initialize() {
      try {
        const [list, provider] = await Promise.all([ctx.api('/api/fwv/reskin/workflows', { signal: abort.signal }), ctx.api('/api/fwv/provider', { signal: abort.signal })]); if (state.disposed) return;
        state.workflows = (list.workflows || []).sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt))); state.provider = provider; state.initialized = true;
        const saved = state.pending && state.workflows.find(view => view.assetId === state.pending.workflowId);
        if (ctx.selection?.workflowId !== undefined) { if (ctx.selection.workflowId) await loadWorkflow(ctx.selection.workflowId); else { state.view = null; render(); } }
        else if (ctx.selection?.templateAssetId) { state.view = null; ctx.setSelection({ workflowId: '' }); render(); }
        else if (saved) { state.unresolved = true; await loadWorkflow(saved.assetId); }
        else if (state.workflows.length) { state.view = state.workflows.at(-1); ctx.setSelection({ workflowId: state.view.assetId }); state.attemptId = state.view.attempts?.find(active)?.id || state.view.selectedCandidateId || state.view.attempts?.at(-1)?.id || ''; render(); }
        else render();
      } catch (error) { notify(ui.text('message091', { v0: error.message }), true); }
    }
    const timer = setInterval(() => {
      if (state.disposed) return; updateProgress();
      const localResultPending = state.view?.attempts?.some(attempt => localAttempt(attempt) && !cancelledLocally(attempt) && attempt.status === 'unknown' && attempt.local?.status === 'dispatched');
      if (!state.view || state.busy || state.polling || !getActive() && !state.unresolved && !localResultPending) return;
      state.polling = true; void loadWorkflow(state.view.assetId).then(() => renderAdjustments()).catch(error => notify(ui.text('message092', { v0: error.message }), true)).finally(() => { state.polling = false; });
    }, 1500);
    render(); void initialize();
    return () => { state.disposed = true; clearInterval(timer); abort.abort(); characterPreview?.dispose(); ui.dispose(); root.remove(); };
  } });
}());
