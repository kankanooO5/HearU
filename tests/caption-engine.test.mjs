import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
const source = readFileSync(new URL('../src/caption-engine.ts', import.meta.url), 'utf8');
const js = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText;
const { CaptionEngine, TranslationQueue } = await import(`data:text/javascript;base64,${Buffer.from(js).toString('base64')}`);

test('partial snapshots replace the active line and a locked line stays unchanged', () => {
  let seen = [];
  const engine = new CaptionEngine(lines => { seen = lines; });

  engine.committed('a', 0);

  for (const text of [
    'Questa',
    'Questa è',
    'Questa è una',
    'Questa è una piccolissima',
    'Questa è una piccolissima collina',
    'Questa è una piccolissima collina artifi',
  ]) {
    engine.partial('a', text, 1);
  }

  assert.equal(
    seen[0].stable + seen[0].active,
    'Questa è una piccolissima collina artifi',
  );

  engine.partial(
    'a',
    'Questa è una piccolissima collina artificiale',
    2,
  );

  engine.complete(
    'a',
    'Questa è una piccolissima collina artificiale.',
    3,
  );

  assert.equal(
    seen[0].stable,
    'Questa è una piccolissima collina artificiale.',
  );

  engine.partial(
    'a',
    'Questa frase non deve sostituire quella bloccata',
    4,
  );

  engine.complete(
    'a',
    'Riscritta interamente.',
    4,
  );

  assert.equal(
    seen[0].stable,
    'Questa è una piccolissima collina artificiale.',
  );
});

test('final revision is local when a final transcript reorders the sentence', () => {
  const engine = new CaptionEngine(() => {});

  engine.partial(
    'a',
    'Augusto è il primo imperatore romano',
    1,
  );

  engine.complete(
    'a',
    'Il primo imperatore di Roma fu Augusto.',
    2,
  );

  assert.equal(
    engine.snapshot[0].stable,
    'Augusto è il primo imperatore romano.',
  );
});

test('one recognized name is corrected in place before locking', () => {
  const engine = new CaptionEngine(() => {});

  engine.partial(
    'a',
    'agosto è il primo imperatore romano',
    1,
  );

  engine.complete(
    'a',
    'Augusto è il primo imperatore romano.',
    2,
  );

  assert.equal(
    engine.snapshot[0].stable,
    'Augusto è il primo imperatore romano.',
  );
});

test('out of order item completions retain commit order', () => {
  const engine = new CaptionEngine(() => {});
  engine.committed('first', 1); engine.committed('second', 2);
  engine.complete('second', 'Seconda frase.', 3); engine.complete('first', 'Prima frase.', 4);
  assert.deepEqual(engine.snapshot.map(line => line.stable), ['Prima frase.', 'Seconda frase.']);
});

test('translation backlog batches and maps results to source lines', async () => {
  const batches = [], done = [];
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const queue = new TranslationQueue(async tasks => { batches.push(tasks.map(x => x.id)); if (batches.length === 1) await gate; return tasks.map(x => `译文 ${x.id}`); }, (id, result) => done.push([id, result]), () => {});
  queue.add([{ id: 'a', text: 'uno' }]);
  queue.add('bcdef'.split('').map(id => ({ id, text: id })));
  release(); await new Promise(resolve => setTimeout(resolve, 10));
  assert.deepEqual(batches, [['a'], ['b', 'c', 'd'], ['e'], ['f']]);
  assert.deepEqual(done.map(x => x[0]), ['a', 'b', 'c', 'd', 'e', 'f']);
});
