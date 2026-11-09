(function (global) {
  function statistic(samples, mode, nullValue = 0) {
    const clean = samples.map(group => group.filter(Number.isFinite));
    if (clean.some(group => group.length === 0)) return NaN;
    if (mode === 'one') {
      const values = clean[0].map(value => value - nullValue);
      if (values.length < 2) return NaN;
      const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
      const variance = values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / (values.length - 1);
      const se = Math.sqrt(variance / values.length);
      return se > 0 ? mean / se : mean === 0 ? 0 : Math.sign(mean) * Infinity;
    }
    const counts = clean.map(group => group.length);
    const all = clean.flat();
    const total = all.length;
    const grandMean = all.reduce((sum, value) => sum + value, 0) / total;
    let between = 0;
    let within = 0;
    for (let index = 0; index < clean.length; index++) {
      const group = clean[index];
      const mean = group.reduce((sum, value) => sum + value, 0) / group.length;
      between += group.length * (mean - grandMean) ** 2;
      within += group.reduce((sum, value) => sum + (value - mean) ** 2, 0);
    }
    const dfBetween = clean.length - 1;
    const dfWithin = total - clean.length;
    if (dfBetween < 1 || dfWithin < 1) return NaN;
    const msWithin = within / dfWithin;
    return msWithin > 0 ? (between / dfBetween) / msWithin : between === 0 ? 0 : Infinity;
  }

  function shuffle(values) {
    for (let index = values.length - 1; index > 0; index--) {
      const other = Math.floor(Math.random() * (index + 1));
      [values[index], values[other]] = [values[other], values[index]];
    }
    return values;
  }

  function createPermutationPlan(subjects, mode) {
    if (mode === 'one') return { signs: subjects.map(() => Math.random() < 0.5 ? -1 : 1) };
    const groupCount = Math.max(...subjects.map(subject => subject.groupIndex)) + 1;
    const sizes = Array.from({ length: groupCount }, (_, index) => subjects.filter(subject => subject.groupIndex === index).length);
    const shuffledSubjects = shuffle(subjects.map((_, index) => index));
    const groupBySubjectIndex = new Int32Array(subjects.length);
    let offset = 0;
    sizes.forEach((size, groupIndex) => {
      for (let index = offset; index < offset + size; index++) groupBySubjectIndex[shuffledSubjects[index]] = groupIndex;
      offset += size;
    });
    return { groupBySubjectIndex, groupCount };
  }

  async function run({ subjects, times, mode, nullValue = 0, permutations = 5000, onProgress = () => {} }) {
    const valuesAtTime = times.map((_, timeIndex) => subjects.map(subject => subject.values[timeIndex]));
    const observed = valuesAtTime.map(values => statistic(mode === 'one' ? [values] : subjects.reduce((groups, subject) => {
      const groupIndex = subject.groupIndex;
      (groups[groupIndex] ||= []).push(values[subjects.indexOf(subject)]);
      return groups;
    }, []), mode, nullValue));
    if (observed.some(Number.isNaN)) {
      throw new Error('Dati insufficienti: servono almeno 2 soggetti nel test a un gruppo e almeno 2 gruppi con varianza residua nel test multi-gruppo.');
    }

    const pointwiseExceed = new Uint32Array(times.length);
    const maxExceed = new Uint32Array(times.length);
    const thresholds = observed.map(value => Math.abs(value));
    const batchSize = 100;
    for (let start = 0; start < permutations; start += batchSize) {
      const stop = Math.min(permutations, start + batchSize);
      for (let iteration = start; iteration < stop; iteration++) {
        let permutedMax = 0;
        const plan = createPermutationPlan(subjects, mode);
        for (let timeIndex = 0; timeIndex < times.length; timeIndex++) {
          let groups;
          if (mode === 'one') {
            const residuals = valuesAtTime[timeIndex].map(value => value - nullValue);
            groups = [residuals.map((value, index) => value * plan.signs[index])];
          } else {
            groups = Array.from({ length: plan.groupCount }, () => []);
            valuesAtTime[timeIndex].forEach((value, subjectIndex) => groups[plan.groupBySubjectIndex[subjectIndex]].push(value));
          }
          const value = statistic(groups, mode);
          const magnitude = Math.abs(value);
          if (magnitude >= Math.abs(observed[timeIndex])) pointwiseExceed[timeIndex]++;
          if (magnitude > permutedMax) permutedMax = magnitude;
        }
        for (let timeIndex = 0; timeIndex < times.length; timeIndex++) {
          if (permutedMax >= thresholds[timeIndex]) maxExceed[timeIndex]++;
        }
      }
      onProgress(stop, permutations);
      await new Promise(resolve => setTimeout(resolve, 0));
    }

    const denominator = permutations + 1;
    return times.map((time, index) => ({
      time,
      statistic: observed[index],
      pUncorrected: (pointwiseExceed[index] + 1) / denominator,
      pAdjusted: (maxExceed[index] + 1) / denominator
    }));
  }

  global.TimeSeriesPermutation = Object.freeze({ run });
})(globalThis);
