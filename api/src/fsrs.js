import { createEmptyCard, fsrs, Rating, State } from "ts-fsrs";

function scheduler(retention) {
  return fsrs({
    request_retention: Number(retention || process.env.FSRS_RETENTION || 0.90),
    maximum_interval: 36500,
    enable_fuzz: true
  });
}

const ratingMap = {
  Again: Rating.Again,
  Hard: Rating.Hard,
  Good: Rating.Good,
  Easy: Rating.Easy
};

export function newFsrsCard(now = new Date()) {
  return serialize(createEmptyCard(now));
}

export function scheduleNext(serialized, ratingName, retention, now = new Date()) {
  const rating = ratingMap[ratingName];
  if (!rating) throw new Error("Invalid FSRS rating");
  const result = scheduler(retention).next(hydrate(serialized), now, rating);
  return { card: serialize(result.card), log: serializeLog(result.log) };
}

export function getStateName(serialized) {
  const s = Number(serialized?.state);
  return ({
    [State.New]:"New",
    [State.Learning]:"Learning",
    [State.Review]:"Review",
    [State.Relearning]:"Relearning"
  })[s] || "FSRS";
}

function hydrate(c) {
  return {
    ...c,
    due: new Date(c.due),
    last_review: c.last_review ? new Date(c.last_review) : undefined
  };
}
function serialize(c) {
  return {
    ...c,
    due: new Date(c.due).toISOString(),
    last_review: c.last_review ? new Date(c.last_review).toISOString() : undefined
  };
}
function serializeLog(log) {
  return {
    ...log,
    review: log.review ? new Date(log.review).toISOString() : undefined
  };
}
