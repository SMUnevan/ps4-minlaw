// Loads and localises the Learning Hub lessons. Lesson content lives in
// data/lessons/*.json, one file per track, so tracks can be added or edited
// independently. Everything is loaded once at startup.

const fs = require('fs');
const path = require('path');
const { pick } = require('./i18n');

const LESSON_DIR = path.join(__dirname, '..', '..', 'data', 'lessons');

const tracks = [];
const lessonsById = new Map();

function load() {
  const files = fs
    .readdirSync(LESSON_DIR)
    .filter((f) => f.endsWith('.json'))
    .sort();

  for (const file of files) {
    const raw = JSON.parse(fs.readFileSync(path.join(LESSON_DIR, file), 'utf8'));
    const track = { ...raw.track, lessonIds: [] };
    for (const lesson of raw.lessons) {
      const withTrack = { ...lesson, trackId: track.id };
      lessonsById.set(lesson.id, withTrack);
      track.lessonIds.push(lesson.id);
    }
    tracks.push(track);
  }
  tracks.sort((a, b) => a.order - b.order);
}
load();

function localiseLessonSummary(lesson, lang) {
  return {
    id: lesson.id,
    trackId: lesson.trackId,
    order: lesson.order,
    minutes: lesson.minutes,
    tags: lesson.tags,
    title: pick(lesson.title, lang),
    summary: pick(lesson.summary, lang),
    hasCase: !!lesson.caseNote
  };
}

function localiseLessonFull(lesson, lang) {
  return {
    ...localiseLessonSummary(lesson, lang),
    content: pick(lesson.content, lang),
    sources: lesson.sources || [],
    caseNote: lesson.caseNote
      ? {
          citation: lesson.caseNote.citation,
          url: lesson.caseNote.url,
          why: pick(lesson.caseNote.why, lang)
        }
      : null,
    check: {
      question: pick(lesson.check.question, lang),
      options: pick(lesson.check.options, lang),
      answerIndex: lesson.check.answerIndex,
      explanation: pick(lesson.check.explanation, lang)
    }
  };
}

function getTracks(lang) {
  return tracks.map((track) => ({
    id: track.id,
    order: track.order,
    icon: track.icon,
    title: pick(track.title, lang),
    description: pick(track.description, lang),
    lessons: track.lessonIds
      .map((id) => localiseLessonSummary(lessonsById.get(id), lang))
      .sort((a, b) => a.order - b.order)
  }));
}

function getLesson(id, lang) {
  const lesson = lessonsById.get(id);
  return lesson ? localiseLessonFull(lesson, lang) : null;
}

function allLessons() {
  return [...lessonsById.values()];
}

function lessonSummary(id, lang) {
  const lesson = lessonsById.get(id);
  return lesson ? localiseLessonSummary(lesson, lang) : null;
}

function lessonCount() {
  return lessonsById.size;
}

module.exports = { getTracks, getLesson, allLessons, lessonSummary, lessonCount };
