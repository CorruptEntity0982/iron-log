(function () {
  'use strict';

  var LS = 'ironlog:';
  var $ = function (sel) { return document.querySelector(sel); };

  var PLATE_STACK_SVG = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M2 12h1.2M20.8 12H22" stroke="currentColor" stroke-width="1.6"/><rect x="6" y="9.5" width="3" height="5" rx="0.6" fill="currentColor"/><rect x="15" y="9.5" width="3" height="5" rx="0.6" fill="currentColor"/><path d="M9 12h6" stroke="currentColor" stroke-width="1.6"/></svg>';
  var EMPTY_PLATE_SVG = '<svg class="plate-mark" viewBox="0 0 32 32" aria-hidden="true"><circle cx="16" cy="16" r="14" class="pm-body"></circle><circle cx="16" cy="16" r="14" class="pm-rim" fill="none"></circle><circle cx="16" cy="16" r="5.5" class="pm-brass" fill="none"></circle><circle cx="16" cy="16" r="3" class="pm-hole"></circle></svg>';
  var CHECK_SVG = '<svg viewBox="0 0 24 24"><path d="M5 13l4 4L19 7" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/></svg>';

  var state = {
    exercises: [],
    templates: [],
    sessions: [],
    activeSessionId: null,
    settings: { unit: 'kg', weightStep: 2.5 },
    ui: { currentView: 'log', historyTab: 'sessions', exercisesTab: 'exercises' }
  };

  var elapsedTickHandle = null;
  var restState = null;
  var audioCtx = null;
  var draftTemplate = null;
  var isNewTemplate = false;
  var exerciseFormDraft = null;
  var exerciseFormEditingId = null;
  var exerciseFormOnSavedExtra = null;
  var pickerOnPick = null;

  // ---------- utils ----------

  function uid(prefix) { return prefix + '_' + Math.random().toString(36).slice(2, 10) + Date.now().toString(36); }
  function safeParse(str, fallback) { if (str == null) return fallback; try { return JSON.parse(str); } catch (e) { return fallback; } }
  function escapeHtml(str) {
    return String(str == null ? '' : str).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function clamp0(n) { return n < 0 ? 0 : n; }
  function formatMMSS(total) {
    total = Math.max(0, Math.round(total));
    var m = Math.floor(total / 60), s = total % 60;
    return m + ':' + String(s).padStart(2, '0');
  }
  function formatElapsed(ms) {
    var total = Math.max(0, Math.floor(ms / 1000));
    var h = Math.floor(total / 3600), m = Math.floor((total % 3600) / 60), s = total % 60;
    if (h > 0) return h + ':' + String(m).padStart(2, '0') + ':' + String(s).padStart(2, '0');
    return m + ':' + String(s).padStart(2, '0');
  }
  function formatDate(ms) {
    return new Date(ms).toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
  }
  function formatVolume(v) { return Math.round(v).toLocaleString(); }
  function weightUnitLabel() { return 'kg'; }
  function unitLabel() { return weightUnitLabel(); }
  function dateStamp() { return new Date().toISOString().slice(0, 10); }
  function normalizeWeightValue(value) { return Math.round(value * 10) / 10; }

  function emptyStateHtml(title, sub) {
    return '<div class="empty-state">' + EMPTY_PLATE_SVG + '<p style="font-weight:600;color:var(--text-dim)">' + escapeHtml(title) + '</p><p>' + escapeHtml(sub) + '</p></div>';
  }

  function getExercise(id) { return state.exercises.find(function (e) { return e.id === id; }); }
  function getTemplate(id) { return state.templates.find(function (t) { return t.id === id; }); }
  function getActiveSession() { return state.sessions.find(function (s) { return s.id === state.activeSessionId; }) || null; }

  function getPreviousTopSet(exerciseId) {
    var sessions = state.sessions.filter(function (s) { return s.finishedAt; }).sort(function (a, b) { return b.startedAt - a.startedAt; });
    for (var i = 0; i < sessions.length; i++) {
      var entry = sessions[i].entries.find(function (e) { return e.exerciseId === exerciseId; });
      if (!entry) continue;
      var done = entry.sets.filter(function (s) { return s.done && s.weight > 0; });
      if (done.length) {
        return done.reduce(function (best, cur) {
          return (cur.weight > best.weight || (cur.weight === best.weight && cur.reps > best.reps)) ? cur : best;
        });
      }
    }
    return null;
  }

  function getPreviousSets(exerciseId) {
    var sessions = state.sessions.filter(function (s) { return s.finishedAt; }).sort(function (a, b) { return b.startedAt - a.startedAt; });
    for (var i = 0; i < sessions.length; i++) {
      var entry = sessions[i].entries.find(function (e) { return e.exerciseId === exerciseId; });
      if (!entry) continue;
      var sets = entry.sets.filter(function (s) { return s.weight > 0 || s.reps > 0; });
      if (sets.length) return sets.map(function (s) { return { weight: s.weight, reps: s.reps }; });
    }
    return [];
  }
  function previousSetFor(prevSets, idx) {
    if (!prevSets.length) return { weight: 0, reps: 0 };
    return prevSets[idx] || prevSets[prevSets.length - 1];
  }

  function estimateTemplateMinutes(t) {
    return Math.max(5, Math.round(t.exercises.reduce(function (sum, e) { return sum + e.targetSets * ((e.restSec || 90) + 35); }, 0) / 60));
  }

  // ---------- persistence ----------

  function persistExercises() { localStorage.setItem(LS + 'exercises', JSON.stringify(state.exercises)); }
  function persistTemplates() { localStorage.setItem(LS + 'templates', JSON.stringify(state.templates)); }
  function persistSessions() { localStorage.setItem(LS + 'sessions', JSON.stringify(state.sessions)); }
  function persistUiState() { localStorage.setItem(LS + 'activeSessionId', JSON.stringify(state.activeSessionId)); }
  function persistSettings() { localStorage.setItem(LS + 'settings', JSON.stringify(state.settings)); }

  function loadState() {
    var savedSettings = safeParse(localStorage.getItem(LS + 'settings'), null);
    var savedExercises = safeParse(localStorage.getItem(LS + 'exercises'), null);
    var savedTemplates = safeParse(localStorage.getItem(LS + 'templates'), null);
    state.sessions = safeParse(localStorage.getItem(LS + 'sessions'), []) || [];
    state.activeSessionId = safeParse(localStorage.getItem(LS + 'activeSessionId'), null);
    state.settings = savedSettings || { unit: 'kg', weightStep: 2.5 };
    state.settings.unit = 'kg';
    state.settings.weightStep = 2.5;
    persistSettings();

    if (savedExercises === null && savedTemplates === null) {
      var seed = buildSeedData();
      state.exercises = seed.exercises;
      state.templates = seed.templates;
      persistExercises();
      persistTemplates();
    } else {
      state.exercises = savedExercises || [];
      state.templates = savedTemplates || [];
    }
  }

  function buildSeedData() {
    var exercises = [];
    function ex(name, muscles) { var e = { id: uid('ex'), name: name, muscles: muscles }; exercises.push(e); return e; }

    var pendlayRow = ex('Pendlay Row', ['Lats', 'Rear Delts', 'Upper Back', 'Biceps']);
    var smithSquat = ex('Smith Machine Back Squat', ['Adductors', 'Glutes', 'Quads', 'Lower Back']);
    var latRaise = ex('Single Arm Cable Lateral Raise', ['Side Delts', 'Front Delts', 'Upper Traps']);
    var sideBend = ex('Dumbbell Side Bend', ['Obliques']);
    var cgbp = ex('Close Grip Bench Press', ['Chest', 'Triceps', 'Front Delts']);
    var pulldownUnder = ex('Underhand Close Grip Cable Lat Pulldown', ['Biceps', 'Lats', 'Forearms', 'Rear Delts']);
    var dbRow = ex('Single Arm Elbow-In Dumbbell Row', ['Lats', 'Rear Delts', 'Upper Back', 'Biceps']);
    var legExt = ex('Leg Extension', ['Quads']);
    var machineRow = ex('Neutral Grip Pin-Loaded Machine Row', ['Lats', 'Rear Delts', 'Upper Back', 'Biceps']);
    var pulldownWide = ex('Wide Grip Cable Lat Pulldown', ['Biceps', 'Lats', 'Forearms', 'Upper Back']);
    var yRaise = ex('Chest-Supported Dumbbell Y-Raise', ['Rear Delts', 'Side Delts']);
    var sumoDL = ex('Sumo Deadlift', ['Adductors', 'Glutes', 'Forearms', 'Hamstrings']);
    var pushPress = ex('Barbell Push Press', ['Front Delts', 'Serratus', 'Side Delts']);
    var hamCurl = ex('Seated Hamstring Curl', ['Hamstrings', 'Calves']);
    var frontRaise = ex('Cable Front Raise', ['Front Delts']);
    var machinePress = ex('Machine Chest Press', ['Front Delts', 'Chest', 'Triceps']);
    var vbarPushdown = ex('Cable V-Bar Triceps Pushdown', ['Triceps']);
    var ropeExt = ex('Cable Rope Overhead Triceps Extension', ['Triceps']);
    var legPress = ex('45° Leg Press', ['Quads', 'Glutes']);
    var shoulderPress = ex('Neutral Grip Pin-Loaded Machine Shoulder Press', ['Front Delts', 'Serratus', 'Side Delts']);
    var ezCurl = ex('EZ Bar Biceps Curl', ['Biceps']);
    var hammerCurl = ex('Incline Hammer Curl', ['Biceps']);
    var preacherCurl = ex('Single Arm Dumbbell Preacher Curl', ['Biceps']);

    function tpl(sets, repMin, repMax, restSec) {
      return function (e) {
        return { exerciseId: e.id, name: e.name, muscles: e.muscles.slice(), targetSets: sets, repMin: repMin, repMax: repMax, restSec: restSec };
      };
    }

    var templates = [
      { id: uid('tpl'), name: 'Workout A', exercises: [
        tpl(4, 11, 13, 120)(pendlayRow),
        tpl(4, 4, 6, 180)(smithSquat),
        tpl(4, 9, 11, 120)(latRaise),
        tpl(3, 12, 15, 120)(sideBend)
      ] },
      { id: uid('tpl'), name: 'Workout B', exercises: [
        tpl(4, 4, 6, 180)(cgbp),
        tpl(4, 11, 13, 120)(pulldownUnder),
        tpl(4, 9, 11, 120)(dbRow),
        tpl(3, 12, 15, 120)(legExt)
      ] },
      { id: uid('tpl'), name: 'Workout C', exercises: [
        tpl(3, 7, 9, 120)(machineRow),
        tpl(3, 9, 11, 120)(pulldownWide),
        tpl(3, 9, 11, 120)(dbRow),
        tpl(3, 9, 11, 120)(yRaise)
      ] },
      { id: uid('tpl'), name: 'Workout D', exercises: [
        tpl(3, 12, 14, 120)(sumoDL),
        tpl(4, 4, 6, 180)(pushPress),
        tpl(4, 9, 11, 120)(hamCurl),
        tpl(3, 9, 11, 120)(frontRaise)
      ] },
      { id: uid('tpl'), name: 'Workout E', exercises: [
        tpl(4, 17, 19, 180)(machinePress),
        tpl(4, 9, 11, 120)(vbarPushdown),
        tpl(4, 9, 11, 120)(ropeExt),
        tpl(3, 12, 15, 120)(legPress)
      ] },
      { id: uid('tpl'), name: 'Workout F', exercises: [
        tpl(4, 10, 12, 180)(shoulderPress),
        tpl(4, 9, 11, 120)(ezCurl),
        tpl(4, 9, 11, 120)(hammerCurl),
        tpl(3, 9, 11, 120)(preacherCurl)
      ] }
    ];

    return { exercises: exercises, templates: templates };
  }

  // ---------- view routing ----------

  function showView(name) {
    state.ui.currentView = name;
    document.querySelectorAll('.view').forEach(function (v) { v.classList.toggle('active', v.dataset.view === name); });
    document.querySelectorAll('.tab-btn').forEach(function (b) { b.classList.toggle('active', b.dataset.target === name); });
    stopElapsedTicker();
    if (name === 'log') renderLog();
    else if (name === 'history') renderHistory();
    else if (name === 'exercises') renderExercises();
  }

  // ---------- Log tab ----------

  function renderLog() {
    var root = $('#view-log');
    var session = getActiveSession();
    if (!session) {
      root.innerHTML = renderStartScreen();
    } else {
      root.innerHTML = renderActiveSessionView(session);
      startElapsedTicker(session);
      if (restState) renderRestBanner();
    }
  }

  function renderTemplateCard(t, action) {
    var names = t.exercises.map(function (e) { return e.name; }).join(' · ');
    var est = estimateTemplateMinutes(t);
    return '<button class="template-card" data-action="' + action + '" data-id="' + t.id + '">' +
      '<div class="template-card-name">' + escapeHtml(t.name) + '</div>' +
      '<div class="template-card-meta">' + t.exercises.length + ' exercises · ~' + est + ' min</div>' +
      '<div class="template-card-exlist">' + escapeHtml(names) + '</div></button>';
  }

  function renderStartScreen() {
    var list = state.templates;
    var cards = list.length
      ? list.map(function (t) { return renderTemplateCard(t, 'start-template'); }).join('')
      : emptyStateHtml('No workouts saved', 'Build one in the Exercises tab, or just start logging.');
    return '<div class="section-title">Start a Workout</div>' + cards +
      '<button class="btn btn-secondary btn-block" data-action="start-empty" style="margin-top:6px">Start Empty Session</button>';
  }

  function targetLine(entry) {
    var parts = [];
    if (entry.repMin != null && entry.repMax != null) parts.push(entry.repMin + '–' + entry.repMax + ' reps');
    if (entry.restSec) parts.push('Rest ' + formatMMSS(entry.restSec));
    return parts.join(' · ');
  }
  function prevLine(entry) {
    var prev = getPreviousTopSet(entry.exerciseId);
    return prev ? ('Last ' + prev.weight + ' ' + weightUnitLabel() + ' × ' + prev.reps) : '';
  }

  function renderSetRow(exIdx, set, si) {
    var weightSuffix = weightUnitLabel();
    return '<div class="set-row' + (set.done ? ' done' : '') + '" id="set-row-' + exIdx + '-' + si + '">' +
      '<button class="set-idx" data-action="remove-set" data-ex-idx="' + exIdx + '" data-set-idx="' + si + '">' + (si + 1) + '</button>' +
      '<div class="stepper">' +
        '<button data-action="dec" data-field="weight" data-ex-idx="' + exIdx + '" data-set-idx="' + si + '">−</button>' +
        '<input type="number" inputmode="decimal" data-role="num-input" data-field="weight" data-ex-idx="' + exIdx + '" data-set-idx="' + si + '" value="' + (set.weight || '') + '" placeholder="0">' +
        '<span class="stepper-suffix">' + weightSuffix + '</span>' +
        '<button data-action="inc" data-field="weight" data-ex-idx="' + exIdx + '" data-set-idx="' + si + '">+</button>' +
      '</div>' +
      '<div class="stepper">' +
        '<button data-action="dec" data-field="reps" data-ex-idx="' + exIdx + '" data-set-idx="' + si + '">−</button>' +
        '<input type="number" inputmode="numeric" data-role="num-input" data-field="reps" data-ex-idx="' + exIdx + '" data-set-idx="' + si + '" value="' + (set.reps || '') + '" placeholder="0">' +
        '<span class="stepper-suffix">reps</span>' +
        '<button data-action="inc" data-field="reps" data-ex-idx="' + exIdx + '" data-set-idx="' + si + '">+</button>' +
      '</div>' +
      '<button class="set-check" data-action="toggle-done" data-ex-idx="' + exIdx + '" data-set-idx="' + si + '">' + CHECK_SVG + '</button>' +
    '</div>';
  }

  function renderExerciseCard(entry, exIdx) {
    var rows = entry.sets.map(function (s, si) { return renderSetRow(exIdx, s, si); }).join('');
    var tLine = targetLine(entry);
    var pLine = prevLine(entry);
    var chips = (entry.muscles && entry.muscles.length) ? ('<div class="chip-row">' + entry.muscles.map(function (m) { return '<span class="chip">' + escapeHtml(m) + '</span>'; }).join('') + '</div>') : '';
    return '<div class="exercise-card" data-exercise-card data-ex-idx="' + exIdx + '">' +
      '<div class="exercise-card-head">' +
        '<div>' +
          '<div class="exercise-card-name">' + escapeHtml(entry.name) + '</div>' +
          (tLine ? '<div class="exercise-card-target">' + tLine + '</div>' : '') +
          (pLine ? '<div class="exercise-card-target">' + pLine + '</div>' : '') +
          chips +
        '</div>' +
        '<button class="icon-btn" data-action="remove-exercise" data-ex-idx="' + exIdx + '" aria-label="Remove exercise" style="font-size:20px">×</button>' +
      '</div>' +
      '<div class="set-table">' + rows + '</div>' +
      '<div class="exercise-card-actions"><button data-action="add-set" data-ex-idx="' + exIdx + '">+ Add Set</button></div>' +
    '</div>';
  }

  function renderActiveSessionView(session) {
    return '<div class="session-header">' +
        '<div>' +
          '<div class="session-header-name">' + escapeHtml(session.templateName || 'Custom Session') + '</div>' +
          '<div class="session-header-timer" id="session-timer">0:00</div>' +
        '</div>' +
        '<div style="display:flex;gap:8px">' +
          '<button class="btn btn-secondary btn-sm" data-action="cancel-session">Discard</button>' +
          '<button class="btn btn-primary btn-sm" data-action="finish-session">Finish</button>' +
        '</div>' +
      '</div>' +
      '<div id="session-exercises">' + session.entries.map(renderExerciseCard).join('') + '</div>' +
      '<button class="add-exercise-btn" data-action="add-exercise">+ Add Exercise</button>' +
      '<div id="rest-banner-slot"></div>';
  }

  function refreshSessionExercises() {
    var session = getActiveSession();
    var el = document.getElementById('session-exercises');
    if (el && session) el.innerHTML = session.entries.map(renderExerciseCard).join('');
  }
  function refreshExerciseCard(exIdx) {
    var session = getActiveSession();
    var el = document.querySelector('[data-exercise-card][data-ex-idx="' + exIdx + '"]');
    if (el && session && session.entries[exIdx]) el.outerHTML = renderExerciseCard(session.entries[exIdx], exIdx);
  }

  function startElapsedTicker(session) {
    stopElapsedTicker();
    tickElapsed(session);
    elapsedTickHandle = setInterval(function () { tickElapsed(session); }, 1000);
  }
  function tickElapsed(session) {
    var el = document.getElementById('session-timer');
    if (el) el.textContent = formatElapsed(Date.now() - session.startedAt);
  }
  function stopElapsedTicker() {
    if (elapsedTickHandle) clearInterval(elapsedTickHandle);
    elapsedTickHandle = null;
  }

  // ---------- rest timer ----------

  function primeAudio() {
    if (!audioCtx) {
      try { audioCtx = new (window.AudioContext || window.webkitAudioContext)(); } catch (e) {}
    }
    if (audioCtx && audioCtx.state === 'suspended') audioCtx.resume();
  }
  function beepOnce(delay) {
    setTimeout(function () {
      primeAudio();
      if (!audioCtx) return;
      try {
        var o = audioCtx.createOscillator(), g = audioCtx.createGain();
        o.type = 'sine'; o.frequency.value = 880;
        o.connect(g); g.connect(audioCtx.destination);
        var t = audioCtx.currentTime;
        g.gain.setValueAtTime(0.0001, t);
        g.gain.exponentialRampToValueAtTime(0.5, t + 0.02);
        g.gain.exponentialRampToValueAtTime(0.0001, t + 0.35);
        o.start(t); o.stop(t + 0.36);
      } catch (e) {}
    }, delay);
  }
  function beep() {
    beepOnce(0); beepOnce(380); beepOnce(760);
    if ('vibrate' in navigator) { try { navigator.vibrate([150, 80, 150, 80, 150]); } catch (e) {} }
  }

  function startRest(seconds) {
    seconds = seconds || 90;
    clearRest(false);
    restState = { endAt: Date.now() + seconds * 1000, total: seconds, handle: null };
    renderRestBanner();
    restState.handle = setInterval(tickRest, 250);
    primeAudio();
  }
  function tickRest() {
    if (!restState) return;
    var remain = Math.max(0, Math.round((restState.endAt - Date.now()) / 1000));
    var slot = document.getElementById('rest-banner-slot');
    if (!slot) { clearRest(false); return; }
    var timeEl = slot.querySelector('.rest-banner-time');
    if (timeEl) timeEl.textContent = formatMMSS(remain);
    if (remain <= 0) { clearRest(true); beep(); }
  }
  function renderRestBanner() {
    var slot = document.getElementById('rest-banner-slot');
    if (!slot || !restState) return;
    slot.innerHTML = '<div class="rest-banner"><div><div class="rest-banner-label">Resting</div><div class="rest-banner-time mono">' +
      formatMMSS(Math.max(0, Math.round((restState.endAt - Date.now()) / 1000))) + '</div></div><button data-action="skip-rest">Skip</button></div>';
  }
  function clearRest(done) {
    if (restState && restState.handle) clearInterval(restState.handle);
    var wasActive = !!restState;
    restState = null;
    var slot = document.getElementById('rest-banner-slot');
    if (!slot) return;
    if (done && wasActive) {
      slot.innerHTML = '<div class="rest-banner" style="background:var(--brass);color:var(--bg)"><div><div class="rest-banner-label" style="color:var(--bg);opacity:.7">Rest complete</div><div class="rest-banner-time mono">Go!</div></div></div>';
      setTimeout(function () { var s = document.getElementById('rest-banner-slot'); if (s) s.innerHTML = ''; }, 2500);
    } else {
      slot.innerHTML = '';
    }
  }

  // ---------- Log actions ----------

  function startSessionFromTemplate(tplId) {
    var t = getTemplate(tplId);
    if (!t) return;
    var entries = t.exercises.map(function (te) {
      var prevSets = getPreviousSets(te.exerciseId);
      var sets = [];
      for (var i = 0; i < te.targetSets; i++) {
        var src = previousSetFor(prevSets, i);
        sets.push({ weight: src.weight || 0, reps: src.reps || 0, done: false });
      }
      return { exerciseId: te.exerciseId, name: te.name, muscles: te.muscles || [], repMin: te.repMin, repMax: te.repMax, restSec: te.restSec, sets: sets };
    });
    var session = { id: uid('ses'), templateId: t.id, templateName: t.name, startedAt: Date.now(), finishedAt: null, entries: entries };
    state.sessions.push(session);
    state.activeSessionId = session.id;
    persistSessions(); persistUiState();
    showView('log');
  }
  function startEmptySession() {
    var session = { id: uid('ses'), templateId: null, templateName: null, startedAt: Date.now(), finishedAt: null, entries: [] };
    state.sessions.push(session);
    state.activeSessionId = session.id;
    persistSessions(); persistUiState();
    showView('log');
  }
  function addExerciseToSession(ex) {
    var session = getActiveSession();
    if (!session) return;
    var prevSets = getPreviousSets(ex.id);
    var sets = [];
    for (var i = 0; i < 3; i++) {
      var src = previousSetFor(prevSets, i);
      sets.push({ weight: src.weight || 0, reps: src.reps || 0, done: false });
    }
    session.entries.push({
      exerciseId: ex.id, name: ex.name, muscles: (ex.muscles || []).slice(),
      repMin: null, repMax: null, restSec: null,
      sets: sets
    });
    persistSessions();
    refreshSessionExercises();
  }
  function addSet(exIdx) {
    var session = getActiveSession();
    var entry = session.entries[exIdx];
    var last = entry.sets[entry.sets.length - 1];
    entry.sets.push({ weight: last ? last.weight : 0, reps: last ? last.reps : 0, done: false });
    persistSessions();
    refreshExerciseCard(exIdx);
  }
  function stepValue(exIdx, setIdx, field, delta) {
    var session = getActiveSession();
    var set = session.entries[exIdx].sets[setIdx];
    var step = field === 'weight' ? state.settings.weightStep : 1;
    var val = clamp0((set[field] || 0) + delta * step);
    set[field] = val;
    persistSessions();
    var input = document.querySelector('input[data-field="' + field + '"][data-ex-idx="' + exIdx + '"][data-set-idx="' + setIdx + '"]');
    if (input) input.value = val || '';
  }
  function toggleDone(exIdx, setIdx) {
    var session = getActiveSession();
    var entry = session.entries[exIdx];
    var set = entry.sets[setIdx];
    set.done = !set.done;
    persistSessions();
    var row = document.getElementById('set-row-' + exIdx + '-' + setIdx);
    if (row) row.classList.toggle('done', set.done);
    if (set.done) startRest(entry.restSec || 90);
  }

  function confirmFinishSession() {
    var session = getActiveSession();
    var anyDone = session.entries.some(function (e) { return e.sets.some(function (s) { return s.done; }); });
    var msg = anyDone ? 'Finish and save this workout?' : 'No sets are marked done yet. Finish anyway?';
    openDialog('Finish Workout', msg, [
      { label: 'Keep Going', style: 'secondary' },
      { label: 'Finish', style: 'primary', onClick: doFinishSession }
    ]);
  }
  function doFinishSession() {
    var session = getActiveSession();
    session.finishedAt = Date.now();
    state.activeSessionId = null;
    persistSessions(); persistUiState();
    stopElapsedTicker(); clearRest(false);
    showView('log');
    toast('Workout saved');
  }
  function confirmCancelSession() {
    openDialog('Discard Workout?', "This deletes everything logged in this session. This can't be undone.", [
      { label: 'Keep Editing', style: 'secondary' },
      { label: 'Discard', style: 'danger', onClick: doCancelSession }
    ]);
  }
  function doCancelSession() {
    state.sessions = state.sessions.filter(function (s) { return s.id !== state.activeSessionId; });
    state.activeSessionId = null;
    persistSessions(); persistUiState();
    stopElapsedTicker(); clearRest(false);
    showView('log');
    toast('Workout discarded');
  }
  function confirmRemoveExercise(exIdx) {
    var session = getActiveSession();
    var entry = session.entries[exIdx];
    openDialog('Remove exercise?', 'Remove "' + entry.name + '" and its logged sets from this session?', [
      { label: 'Cancel', style: 'secondary' },
      { label: 'Remove', style: 'danger', onClick: function () {
        session.entries.splice(exIdx, 1);
        persistSessions();
        refreshSessionExercises();
      } }
    ]);
  }
  function confirmRemoveSet(exIdx, setIdx) {
    var session = getActiveSession();
    var entry = session.entries[exIdx];
    if (entry.sets.length <= 1) { toast('An exercise needs at least one set'); return; }
    openDialog('Remove set?', 'Remove set ' + (setIdx + 1) + '?', [
      { label: 'Cancel', style: 'secondary' },
      { label: 'Remove', style: 'danger', onClick: function () {
        entry.sets.splice(setIdx, 1);
        persistSessions();
        refreshExerciseCard(exIdx);
      } }
    ]);
  }

  // ---------- History tab ----------

  function renderHistory() {
    var root = $('#view-history');
    var tab = state.ui.historyTab;
    root.innerHTML =
      '<div class="segmented">' +
        '<button data-action="history-tab" data-tab="sessions" class="' + (tab === 'sessions' ? 'active' : '') + '">Sessions</button>' +
        '<button data-action="history-tab" data-tab="exercises" class="' + (tab === 'exercises' ? 'active' : '') + '">Exercises</button>' +
      '</div>' +
      '<div id="history-body">' + (tab === 'sessions' ? renderSessionsList() : renderExerciseHistoryPicker()) + '</div>';
  }

  function computeVolume(session) {
    return session.entries.reduce(function (sum, e) {
      return sum + e.sets.filter(function (s) { return s.done; }).reduce(function (a, s) { return a + s.weight * s.reps; }, 0);
    }, 0);
  }

  function renderSessionsList() {
    var list = state.sessions.filter(function (s) { return s.finishedAt; }).sort(function (a, b) { return b.startedAt - a.startedAt; });
    if (!list.length) return emptyStateHtml('No sessions yet', 'Finished workouts will show up here.');
    var rows = list.map(function (s) {
      return '<button class="list-row session-summary-row" data-action="open-session" data-id="' + s.id + '">' +
        '<div class="list-row-main">' +
          '<div class="list-row-title">' + escapeHtml(s.templateName || 'Custom Session') + '</div>' +
          '<div class="list-row-sub">' + formatDate(s.startedAt) + ' · ' + s.entries.length + ' exercises</div>' +
        '</div>' +
        '<div class="volume-badge">' + PLATE_STACK_SVG + formatVolume(computeVolume(s)) + ' ' + unitLabel() + '</div>' +
      '</button>';
    }).join('');
    return '<div class="card" style="padding:2px 10px">' + rows + '</div>';
  }

  function openSessionDetail(id) {
    var s = state.sessions.find(function (x) { return x.id === id; });
    if (!s) return;
    var body = s.entries.map(function (e) {
      var setLines = e.sets.map(function (st, i) {
        return '<div style="display:flex;justify-content:space-between;padding:3px 0;font-family:var(--mono);font-size:13px;' + (st.done ? '' : 'opacity:.45') + '">' +
          '<span>Set ' + (i + 1) + '</span><span>' + st.weight + ' ' + unitLabel() + ' × ' + st.reps + (st.done ? '' : ' (skipped)') + '</span></div>';
      }).join('');
      var chips = (e.muscles && e.muscles.length) ? ('<div class="chip-row" style="margin-bottom:6px">' + e.muscles.map(function (m) { return '<span class="chip">' + escapeHtml(m) + '</span>'; }).join('') + '</div>') : '';
      return '<div class="card"><div class="list-row-title" style="margin-bottom:2px">' + escapeHtml(e.name) + '</div>' + chips + setLines + '</div>';
    }).join('');
    var html = '<div class="sheet-handle"></div>' +
      '<div class="sheet-title">' + escapeHtml(s.templateName || 'Custom Session') + '</div>' +
      '<div class="volume-badge" style="margin-bottom:14px">' + PLATE_STACK_SVG + formatVolume(computeVolume(s)) + ' ' + unitLabel() + ' total · ' + formatDate(s.startedAt) + '</div>' +
      body +
      '<button class="btn btn-secondary btn-block" data-action="delete-session" data-id="' + s.id + '" style="margin-top:12px;color:var(--red)">Delete Session</button>';
    openSheet(html);
  }

  function confirmDeleteSession(id) {
    openDialog('Delete session?', 'This permanently deletes this logged workout.', [
      { label: 'Cancel', style: 'secondary' },
      { label: 'Delete', style: 'danger', onClick: function () {
        state.sessions = state.sessions.filter(function (s) { return s.id !== id; });
        persistSessions();
        closeSheet();
        renderHistory();
        toast('Session deleted');
      } }
    ]);
  }

  function getExercisesWithHistory() {
    var ids = [];
    state.sessions.filter(function (s) { return s.finishedAt; }).forEach(function (s) {
      s.entries.forEach(function (e) {
        if (e.sets.some(function (st) { return st.done; }) && ids.indexOf(e.exerciseId) === -1) ids.push(e.exerciseId);
      });
    });
    return ids.map(function (id) {
      var live = getExercise(id);
      if (live) return live;
      for (var i = 0; i < state.sessions.length; i++) {
        var e = state.sessions[i].entries.find(function (x) { return x.exerciseId === id; });
        if (e) return { id: id, name: e.name, muscles: e.muscles || [] };
      }
      return { id: id, name: 'Unknown Exercise', muscles: [] };
    }).sort(function (a, b) { return a.name.localeCompare(b.name); });
  }

  function renderExerciseHistoryPicker() {
    var list = getExercisesWithHistory();
    if (!list.length) return emptyStateHtml('No exercise history yet', 'Finish a workout to see progress here.');
    var rows = list.map(function (e) {
      var chips = e.muscles.length ? ('<div class="chip-row">' + e.muscles.slice(0, 3).map(function (m) { return '<span class="chip">' + escapeHtml(m) + '</span>'; }).join('') + '</div>') : '';
      return '<button class="list-row" data-action="open-exercise-history" data-id="' + e.id + '">' +
        '<div class="list-row-main"><div class="list-row-title">' + escapeHtml(e.name) + '</div>' + chips + '</div>' +
        '<span class="list-row-chevron">›</span></button>';
    }).join('');
    return '<div class="card" style="padding:2px 10px">' + rows + '</div>';
  }

  function buildSparkline(points) {
    var weights = points.map(function (p) { return p.weight; });
    var minW = Math.min.apply(null, weights), maxW = Math.max.apply(null, weights);
    if (minW === maxW) { minW -= 5; maxW += 5; }
    var W = 300, H = 90, pad = 8;
    var coords = points.map(function (p, i) {
      var x = points.length > 1 ? pad + i * (W - 2 * pad) / (points.length - 1) : W / 2;
      var y = H - pad - ((p.weight - minW) / (maxW - minW)) * (H - 2 * pad);
      return [x, y];
    });
    var line = coords.map(function (c) { return c[0] + ',' + c[1]; }).join(' ');
    var dots = coords.map(function (c) { return '<circle cx="' + c[0] + '" cy="' + c[1] + '" r="3" fill="#c9a768"/>'; }).join('');
    return '<div style="display:flex;justify-content:space-between;font-family:var(--mono);font-size:11px;color:var(--text-faint);margin-bottom:2px">' +
      '<span>' + Math.round(maxW) + ' ' + unitLabel() + '</span><span>' + Math.round(minW) + ' ' + unitLabel() + '</span></div>' +
      '<svg class="sparkline" viewBox="0 0 ' + W + ' ' + H + '" preserveAspectRatio="none"><polyline points="' + line + '" fill="none" stroke="#c9a768" stroke-width="2"/>' + dots + '</svg>';
  }

  function openExerciseHistorySheet(id) {
    var points = [];
    state.sessions.filter(function (s) { return s.finishedAt; }).sort(function (a, b) { return a.startedAt - b.startedAt; }).forEach(function (s) {
      var e = s.entries.find(function (x) { return x.exerciseId === id; });
      if (!e) return;
      var done = e.sets.filter(function (st) { return st.done && st.weight > 0; });
      if (!done.length) return;
      var top = done.reduce(function (best, cur) { return (cur.weight > best.weight || (cur.weight === best.weight && cur.reps > best.reps)) ? cur : best; });
      points.push({ date: s.startedAt, weight: top.weight, reps: top.reps });
    });
    var liveEx = getExercise(id);
    var displayName = liveEx ? liveEx.name : (points.length ? 'Exercise' : 'Exercise');
    if (!liveEx) {
      for (var i = 0; i < state.sessions.length; i++) {
        var e = state.sessions[i].entries.find(function (x) { return x.exerciseId === id; });
        if (e) { displayName = e.name; break; }
      }
    }
    var rowsHtml = points.slice().reverse().map(function (p) {
      return '<div class="list-row"><div class="list-row-main"><div class="list-row-title mono" style="font-size:14px">' +
        p.weight + ' ' + unitLabel() + ' × ' + p.reps + '</div><div class="list-row-sub">' + formatDate(p.date) + '</div></div></div>';
    }).join('');
    var html = '<div class="sheet-handle"></div>' +
      '<div class="sheet-title">' + escapeHtml(displayName) + '</div>' +
      (points.length > 1 ? buildSparkline(points) : '') +
      '<div class="card" style="padding:2px 10px;margin-top:10px">' + rowsHtml + '</div>';
    openSheet(html);
  }

  // ---------- Exercises tab ----------

  function renderExercises() {
    var root = $('#view-exercises');
    var tab = state.ui.exercisesTab;
    root.innerHTML =
      '<div class="segmented">' +
        '<button data-action="exercises-tab" data-tab="exercises" class="' + (tab === 'exercises' ? 'active' : '') + '">Exercises</button>' +
        '<button data-action="exercises-tab" data-tab="workouts" class="' + (tab === 'workouts' ? 'active' : '') + '">Workouts</button>' +
      '</div>' +
      (tab === 'exercises' ? renderExerciseLibrary() : renderTemplatesLibrary());
  }

  function renderExerciseLibrary() {
    var list = state.exercises.slice().sort(function (a, b) { return a.name.localeCompare(b.name); });
    var body = list.length
      ? '<div class="card" style="padding:2px 10px">' + list.map(function (e) {
          var chips = e.muscles.length ? ('<div class="chip-row">' + e.muscles.map(function (m) { return '<span class="chip">' + escapeHtml(m) + '</span>'; }).join('') + '</div>') : '';
          return '<button class="list-row" data-action="edit-exercise" data-id="' + e.id + '">' +
            '<div class="list-row-main"><div class="list-row-title">' + escapeHtml(e.name) + '</div>' + chips + '</div>' +
            '<span class="list-row-chevron">›</span></button>';
        }).join('') + '</div>'
      : emptyStateHtml('No exercises yet', 'Add your first exercise to get started.');
    return body + '<button class="btn btn-secondary btn-block" data-action="add-exercise-lib" style="margin-top:12px">+ Add Exercise</button>';
  }

  function renderTemplatesLibrary() {
    var list = state.templates;
    var body = list.length
      ? list.map(function (t) { return renderTemplateCard(t, 'edit-template'); }).join('')
      : emptyStateHtml('No workouts yet', 'Create a workout template to speed up logging.');
    return body + '<button class="btn btn-secondary btn-block" data-action="add-template" style="margin-top:4px">+ New Workout</button>';
  }

  function openExerciseForm(existingId, onSavedExtra) {
    exerciseFormEditingId = existingId || null;
    var existing = existingId ? getExercise(existingId) : null;
    exerciseFormDraft = { name: existing ? existing.name : '', musclesText: existing ? existing.muscles.join(', ') : '' };
    exerciseFormOnSavedExtra = onSavedExtra || null;
    var html = '<div class="sheet-handle"></div>' +
      '<div class="sheet-title">' + (existing ? 'Edit Exercise' : 'New Exercise') + '</div>' +
      '<div class="field"><label>Name</label><input type="text" id="exf-name" value="' + escapeHtml(exerciseFormDraft.name) + '" placeholder="e.g. Barbell Bench Press"></div>' +
      '<div class="field"><label>Muscles (comma separated)</label><input type="text" id="exf-muscles" value="' + escapeHtml(exerciseFormDraft.musclesText) + '" placeholder="Chest, Triceps, Front Delts"></div>' +
      '<div class="sheet-actions">' +
        (existing ? '<button class="btn btn-secondary" data-action="delete-exercise" data-id="' + existing.id + '">Delete</button>' : '') +
        '<button class="btn btn-primary" data-action="exercise-form-save">Save</button>' +
      '</div>';
    openSheet(html);
    document.getElementById('exf-name').addEventListener('input', function (e) { exerciseFormDraft.name = e.target.value; });
    document.getElementById('exf-muscles').addEventListener('input', function (e) { exerciseFormDraft.musclesText = e.target.value; });
  }
  function saveExerciseFormDraft() {
    var name = exerciseFormDraft.name.trim();
    if (!name) { toast('Enter a name'); return; }
    var muscles = exerciseFormDraft.musclesText.split(',').map(function (s) { return s.trim(); }).filter(Boolean);
    var exObj;
    if (exerciseFormEditingId) {
      exObj = getExercise(exerciseFormEditingId);
      exObj.name = name; exObj.muscles = muscles;
    } else {
      exObj = { id: uid('ex'), name: name, muscles: muscles };
      state.exercises.push(exObj);
    }
    persistExercises();
    closeSheet();
    renderExercises();
    toast('Exercise saved');
    if (exerciseFormOnSavedExtra) exerciseFormOnSavedExtra(exObj);
  }
  function confirmDeleteExercise(id) {
    var exObj = getExercise(id);
    if (!exObj) return;
    openDialog('Delete exercise?', 'Remove "' + exObj.name + '" from your library? Past logs are unaffected.', [
      { label: 'Cancel', style: 'secondary' },
      { label: 'Delete', style: 'danger', onClick: function () {
        state.exercises = state.exercises.filter(function (e) { return e.id !== id; });
        persistExercises();
        closeSheet();
        renderExercises();
        toast('Exercise deleted');
      } }
    ]);
  }

  function openTemplateEditor(existingId) {
    isNewTemplate = !existingId;
    var existing = existingId ? getTemplate(existingId) : null;
    draftTemplate = existing ? JSON.parse(JSON.stringify(existing)) : { id: null, name: '', exercises: [] };
    renderTemplateEditorSheet();
  }
  function renderTplExRow(e, i) {
    return '<div class="tpl-ex-row">' +
      '<div class="tpl-ex-row-head"><div class="tpl-ex-row-name">' + escapeHtml(e.name) + '</div>' +
      '<button class="tpl-ex-remove" data-action="tpl-remove-exercise" data-idx="' + i + '">Remove</button></div>' +
      '<div class="tpl-ex-row-controls">' +
        '<div class="field"><label>Sets</label><input type="number" data-tpl-field="targetSets" data-idx="' + i + '" value="' + e.targetSets + '"></div>' +
        '<div class="field"><label>Rep min</label><input type="number" data-tpl-field="repMin" data-idx="' + i + '" value="' + e.repMin + '"></div>' +
        '<div class="field"><label>Rep max</label><input type="number" data-tpl-field="repMax" data-idx="' + i + '" value="' + e.repMax + '"></div>' +
        '<div class="field"><label>Rest (sec)</label><input type="number" data-tpl-field="restSec" data-idx="' + i + '" value="' + e.restSec + '"></div>' +
      '</div></div>';
  }
  function renderTemplateEditorSheet() {
    var html = '<div class="sheet-handle"></div>' +
      '<div class="sheet-title">' + (isNewTemplate ? 'New Workout' : 'Edit Workout') + '</div>' +
      '<div class="field"><label>Name</label><input type="text" id="tpl-name" value="' + escapeHtml(draftTemplate.name) + '" placeholder="Workout A"></div>' +
      '<div id="tpl-ex-list">' + (draftTemplate.exercises.length ? draftTemplate.exercises.map(renderTplExRow).join('') : '<p style="color:var(--text-faint);font-size:13px">No exercises yet.</p>') + '</div>' +
      '<button class="btn btn-secondary btn-block" data-action="tpl-add-exercise" style="margin:10px 0">+ Add Exercise</button>' +
      '<div class="sheet-actions">' +
        (!isNewTemplate ? '<button class="btn btn-secondary" data-action="tpl-delete">Delete</button>' : '') +
        '<button class="btn btn-primary" data-action="tpl-save">Save</button>' +
      '</div>';
    openSheet(html);
    document.getElementById('tpl-name').addEventListener('input', function (e) { draftTemplate.name = e.target.value; });
  }
  function saveDraftTemplate() {
    var name = draftTemplate.name.trim();
    if (!name) { toast('Enter a workout name'); return; }
    if (!draftTemplate.exercises.length) { toast('Add at least one exercise'); return; }
    draftTemplate.name = name;
    if (draftTemplate.id) {
      var idx = state.templates.findIndex(function (t) { return t.id === draftTemplate.id; });
      if (idx >= 0) state.templates[idx] = draftTemplate;
    } else {
      draftTemplate.id = uid('tpl');
      state.templates.push(draftTemplate);
    }
    persistTemplates();
    closeSheet();
    renderExercises();
    toast('Workout saved');
  }
  function confirmDeleteTemplate(id) {
    var t = getTemplate(id);
    if (!t) return;
    openDialog('Delete workout?', 'Delete "' + t.name + '"? This won\'t affect past logged sessions.', [
      { label: 'Cancel', style: 'secondary' },
      { label: 'Delete', style: 'danger', onClick: function () {
        state.templates = state.templates.filter(function (x) { return x.id !== id; });
        persistTemplates();
        closeSheet();
        renderExercises();
        toast('Workout deleted');
      } }
    ]);
  }

  // ---------- exercise picker (shared by session + template editor) ----------

  function renderExercisePickerList(query) {
    var q = query.trim().toLowerCase();
    var list = state.exercises.filter(function (e) { return !q || e.name.toLowerCase().indexOf(q) !== -1; }).sort(function (a, b) { return a.name.localeCompare(b.name); });
    if (!list.length) return '<div class="empty-state"><p>No exercises match.</p></div>';
    return '<div class="card" style="padding:2px 10px;max-height:44vh;overflow-y:auto">' + list.map(function (e) {
      var chips = e.muscles.length ? ('<div class="chip-row">' + e.muscles.map(function (m) { return '<span class="chip">' + escapeHtml(m) + '</span>'; }).join('') + '</div>') : '';
      return '<button class="list-row" data-action="pick-exercise" data-id="' + e.id + '">' +
        '<div class="list-row-main"><div class="list-row-title">' + escapeHtml(e.name) + '</div>' + chips + '</div></button>';
    }).join('') + '</div>';
  }
  function openExercisePickerSheet(onPick) {
    pickerOnPick = onPick;
    var html = '<div class="sheet-handle"></div>' +
      '<div class="sheet-title">Add Exercise</div>' +
      '<div class="field"><input type="text" id="ex-picker-search" placeholder="Search exercises..."></div>' +
      '<div id="ex-picker-list">' + renderExercisePickerList('') + '</div>' +
      '<button class="btn btn-secondary btn-block" data-action="picker-create-new" style="margin-top:10px">+ Create New Exercise</button>';
    openSheet(html);
    document.getElementById('ex-picker-search').addEventListener('input', function (e) {
      document.getElementById('ex-picker-list').innerHTML = renderExercisePickerList(e.target.value);
    });
  }

  // ---------- modals / toast ----------

  function openSheet(innerHtml) {
    var root = document.getElementById('modal-root');
    root.innerHTML = '<div class="modal-backdrop"><div class="sheet" data-sheet-content>' + innerHtml + '</div></div>';
    var backdrop = root.querySelector('.modal-backdrop');
    backdrop.addEventListener('click', function (e) { if (e.target === backdrop) closeSheet(); });
  }
  function closeSheet() { document.getElementById('modal-root').innerHTML = ''; }

  function openDialog(title, message, actions) {
    var wrap = document.createElement('div');
    wrap.className = 'dialog-backdrop';
    wrap.innerHTML = '<div class="dialog"><h3 style="font-size:17px;font-weight:700;margin:0">' + escapeHtml(title) + '</h3>' +
      '<p>' + escapeHtml(message) + '</p>' +
      '<div class="sheet-actions">' + actions.map(function (a, i) { return '<button class="btn btn-' + (a.style || 'secondary') + '" data-dlg-idx="' + i + '">' + escapeHtml(a.label) + '</button>'; }).join('') + '</div></div>';
    document.body.appendChild(wrap);
    wrap.querySelectorAll('[data-dlg-idx]').forEach(function (btn, i) {
      btn.addEventListener('click', function () {
        wrap.remove();
        if (actions[i].onClick) actions[i].onClick();
      });
    });
    wrap.addEventListener('click', function (e) { if (e.target === wrap) wrap.remove(); });
  }

  function toast(msg) {
    var el = document.createElement('div');
    el.className = 'toast';
    el.textContent = msg;
    document.getElementById('toast-root').appendChild(el);
    setTimeout(function () { el.remove(); }, 2200);
  }

  // ---------- settings / backup ----------

  function openSettingsSheet() {
    var html = '<div class="sheet-handle"></div>' +
      '<div class="sheet-title">Backup &amp; Settings</div>' +
      '<p style="color:var(--text-dim);font-size:13px;margin-bottom:16px">Your data lives only on this device. Export a backup now and then, especially before switching phones.</p>' +
      '<button class="btn btn-secondary btn-block" data-action="export-data" style="margin-bottom:10px">Export Backup (JSON)</button>' +
      '<button class="btn btn-secondary btn-block" data-action="import-data" style="margin-bottom:10px">Import Backup</button>' +
      '<input type="file" id="import-file-input" accept="application/json" style="display:none">' +
      '<button class="btn btn-ghost btn-block" data-action="clear-all-data" style="margin-top:6px;color:var(--red)">Clear All Data</button>' +
      '<p style="color:var(--text-faint);font-size:11px;margin-top:18px;text-align:center">Iron Log · works fully offline</p>';
    openSheet(html);
  }
  function exportData() {
    var data = { exportedAt: Date.now(), version: 2, unit: state.settings.unit, exercises: state.exercises, templates: state.templates, sessions: state.sessions };
    var blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url; a.download = 'iron-log-backup-' + dateStamp() + '.json';
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
    toast('Backup downloaded');
  }
  function handleImportFile(file) {
    if (!file) return;
    var reader = new FileReader();
    reader.onload = function () {
      var data;
      try { data = JSON.parse(reader.result); } catch (e) { toast("That file isn't valid JSON"); return; }
      if (!data || !Array.isArray(data.exercises) || !Array.isArray(data.templates) || !Array.isArray(data.sessions)) {
        toast("That doesn't look like an Iron Log backup"); return;
      }
      openDialog('Import Backup?', "This replaces all current data on this device with the backup file. This can't be undone.", [
        { label: 'Cancel', style: 'secondary' },
        { label: 'Import', style: 'danger', onClick: function () {
          state.exercises = data.exercises; state.templates = data.templates; state.sessions = data.sessions; state.activeSessionId = null;
          persistExercises(); persistTemplates(); persistSessions(); persistUiState();
          closeSheet();
          showView(state.ui.currentView);
          toast('Backup imported');
        } }
      ]);
    };
    reader.readAsText(file);
  }
  function confirmClearAllData() {
    openDialog('Clear all data?', "This deletes every exercise, workout, and logged session. This can't be undone.", [
      { label: 'Cancel', style: 'secondary' },
      { label: 'Clear Everything', style: 'danger', onClick: function () {
        state.exercises = []; state.templates = []; state.sessions = []; state.activeSessionId = null;
        persistExercises(); persistTemplates(); persistSessions(); persistUiState();
        closeSheet();
        showView('log');
        toast('All data cleared');
      } }
    ]);
  }

  // ---------- global event wiring ----------

  function handleAction(action, el) {
    switch (action) {
      case 'start-template': startSessionFromTemplate(el.dataset.id); break;
      case 'start-empty': startEmptySession(); break;
      case 'finish-session': confirmFinishSession(); break;
      case 'cancel-session': confirmCancelSession(); break;
      case 'add-exercise': openExercisePickerSheet(function (ex) { addExerciseToSession(ex); }); break;
      case 'remove-exercise': confirmRemoveExercise(+el.dataset.exIdx); break;
      case 'add-set': addSet(+el.dataset.exIdx); break;
      case 'remove-set': confirmRemoveSet(+el.dataset.exIdx, +el.dataset.setIdx); break;
      case 'dec': stepValue(+el.dataset.exIdx, +el.dataset.setIdx, el.dataset.field, -1); break;
      case 'inc': stepValue(+el.dataset.exIdx, +el.dataset.setIdx, el.dataset.field, 1); break;
      case 'toggle-done': toggleDone(+el.dataset.exIdx, +el.dataset.setIdx); break;
      case 'skip-rest': clearRest(false); break;
      case 'history-tab': state.ui.historyTab = el.dataset.tab; renderHistory(); break;
      case 'open-session': openSessionDetail(el.dataset.id); break;
      case 'open-exercise-history': openExerciseHistorySheet(el.dataset.id); break;
      case 'delete-session': confirmDeleteSession(el.dataset.id); break;
      case 'exercises-tab': state.ui.exercisesTab = el.dataset.tab; renderExercises(); break;
      case 'add-exercise-lib': openExerciseForm(null); break;
      case 'edit-exercise': openExerciseForm(el.dataset.id); break;
      case 'delete-exercise': confirmDeleteExercise(el.dataset.id); break;
      case 'add-template': openTemplateEditor(null); break;
      case 'edit-template': openTemplateEditor(el.dataset.id); break;
      case 'tpl-add-exercise':
        openExercisePickerSheet(function (ex) {
          draftTemplate.exercises.push({ exerciseId: ex.id, name: ex.name, muscles: (ex.muscles || []).slice(), targetSets: 3, repMin: 8, repMax: 12, restSec: 90 });
          renderTemplateEditorSheet();
        });
        break;
      case 'tpl-remove-exercise': draftTemplate.exercises.splice(+el.dataset.idx, 1); renderTemplateEditorSheet(); break;
      case 'tpl-save': saveDraftTemplate(); break;
      case 'tpl-delete': confirmDeleteTemplate(draftTemplate.id); break;
      case 'pick-exercise': { var picked = getExercise(el.dataset.id); closeSheet(); if (pickerOnPick) pickerOnPick(picked); break; }
      case 'picker-create-new': closeSheet(); openExerciseForm(null, function (ex) { if (pickerOnPick) pickerOnPick(ex); }); break;
      case 'exercise-form-save': saveExerciseFormDraft(); break;
      case 'export-data': exportData(); break;
      case 'import-data': document.getElementById('import-file-input').click(); break;
      case 'clear-all-data': confirmClearAllData(); break;
      case 'close-sheet': closeSheet(); break;
    }
  }

  function init() {
    loadState();
    registerServiceWorker();

    document.getElementById('btn-settings').addEventListener('click', openSettingsSheet);
    document.getElementById('tabbar').addEventListener('click', function (e) {
      var b = e.target.closest('.tab-btn');
      if (b) showView(b.dataset.target);
    });
    document.addEventListener('click', function (e) {
      var el = e.target.closest('[data-action]');
      if (!el) return;
      handleAction(el.dataset.action, el);
    });
    document.addEventListener('input', function (e) {
      var t = e.target;
      if (t.matches && t.matches('[data-role="num-input"]')) {
        var exIdx = +t.dataset.exIdx, setIdx = +t.dataset.setIdx, field = t.dataset.field;
        var session = getActiveSession();
        if (!session) return;
        var val = t.value === '' ? 0 : clamp0(parseFloat(t.value) || 0);
        session.entries[exIdx].sets[setIdx][field] = val;
        persistSessions();
      } else if (t.matches && t.matches('[data-tpl-field]')) {
        var idx = +t.dataset.idx, field2 = t.dataset.tplField;
        var val2 = parseInt(t.value, 10);
        if (isNaN(val2) || val2 < 0) val2 = 0;
        draftTemplate.exercises[idx][field2] = val2;
      }
    });
    document.addEventListener('change', function (e) {
      if (e.target.id === 'import-file-input') handleImportFile(e.target.files[0]);
    });

    showView(state.ui.currentView || 'log');
  }

  function registerServiceWorker() {
    if ('serviceWorker' in navigator) {
      window.addEventListener('load', function () {
        navigator.serviceWorker.register('sw.js').catch(function () {});
      });
    }
  }

  document.addEventListener('DOMContentLoaded', init);
})();
