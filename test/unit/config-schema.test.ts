// The JSON Schema of sealup.yml (decision 0012, ticket 09): generated from the zod/mini schema,
// draft-07, shipped in the package as `schema.json`. The committed file must be what the
// schema generates, so an editor never checks a config against an older shape.

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { schemaFile, schemaText } from '../../scripts/schema.ts';
import { configJsonSchema } from '../../src/config/index.ts';

describe('configJsonSchema', () => {
  const schema = configJsonSchema();

  it('is draft-07, with the shorthand and the targets shapes, each closed to unknown keys', () => {
    expect(schema.$schema).toBe('http://json-schema.org/draft-07/schema#');
    const shapes = schema.anyOf as { properties: object; additionalProperties: unknown }[];
    expect(shapes.map((shape) => Object.keys(shape.properties).sort())).toEqual([
      [
        'allow',
        'checkServer',
        'exclude',
        'hostKey',
        'manifest',
        'parallel',
        'passphrase',
        'password',
        'privateKey',
        'pull',
        'server',
        'timeout',
        'tlsFingerprint',
        'upload',
        'url',
        'write',
      ],
      ['exclude', 'manifest', 'parallel', 'pull', 'targets', 'timeout', 'upload', 'write'],
    ]);
    expect(shapes.map((shape) => shape.additionalProperties)).toEqual([false, false]);
  });

  // Spec #41 decision 4: at most 16 connections over ftp:// and ftps://, flagged by an editor.
  // Draft-07's if/then, applied as an editor does: `if` holds when `server` matches its pattern.
  it.each([
    ['ftp://deploy@ftp.example.com/www', 16],
    ['ftps://deploy@ftp.example.com/www', 16],
    ['sftp://deploy@ssh.example.com/www', 256],
    ['ssh://deploy@ssh.example.com/www', 256],
  ])('caps parallel for %s at %d, in the shorthand and in a named target', (server, max) => {
    interface Shape {
      properties: Record<string, { maximum?: number; additionalProperties?: Shape }>;
      if?: { properties: { server: { pattern: string } }; required: string[] };
      then?: { properties: { parallel: { maximum: number } } };
    }
    const maximum = (shape: Shape | undefined): number | undefined => {
      const condition = shape?.if;
      const applies =
        condition?.required.includes('server') &&
        new RegExp(condition.properties.server.pattern).test(server);
      return applies
        ? shape?.then?.properties.parallel.maximum
        : shape?.properties.parallel?.maximum;
    };
    const [shorthand, named] = schema.anyOf as Shape[];
    expect(maximum(shorthand)).toBe(max);
    expect(maximum(named?.properties.targets?.additionalProperties)).toBe(max);
  });

  it('describes the tune keys as the loader checks them', () => {
    const [shorthand] = schema.anyOf as { properties: Record<string, object> }[];
    expect(shorthand?.properties.parallel).toMatchObject({
      type: 'integer',
      minimum: 1,
      maximum: 256,
    });
    expect(shorthand?.properties.timeout).toMatchObject({
      type: 'string',
      pattern: '^([1-9][0-9]{0,5})(s|m)$',
    });
    expect(shorthand?.properties.allow).toMatchObject({
      type: 'array',
      items: { enum: ['empty-source', 'symlinks', 'root-folder'] },
    });
    expect(shorthand?.properties.checkServer).toMatchObject({
      type: 'boolean',
      description: expect.stringContaining('changed on the server'),
    });
  });

  it('says a pull entry is a server path and the local folder it goes to', () => {
    const [shorthand] = schema.anyOf as { properties: Record<string, object> }[];
    expect(shorthand?.properties.pull).toMatchObject({
      type: 'object',
      description: expect.stringContaining('for sealup pull'),
      additionalProperties: {
        type: 'string',
        description: expect.stringContaining('inside the folder of sealup.yml'),
      },
    });
  });

  it('says an upload entry takes a folder or a single file, each to its server path', () => {
    const [shorthand] = schema.anyOf as { properties: Record<string, object> }[];
    expect(shorthand?.properties.upload).toMatchObject({
      description: expect.stringContaining('single file'),
      anyOf: [
        { type: 'string' },
        {
          type: 'object',
          additionalProperties: {
            anyOf: [
              {
                anyOf: [
                  { type: 'string', description: expect.stringContaining('file path') },
                  {
                    properties: {
                      to: { description: expect.stringContaining('file path') },
                      exclude: { type: 'array' },
                    },
                  },
                ],
              },
              {
                type: 'array',
                minItems: 1,
                items: {
                  anyOf: [
                    { type: 'string' },
                    { properties: { to: { type: 'string' }, exclude: { type: 'array' } } },
                  ],
                },
              },
            ],
          },
        },
      ],
    });
  });

  it('requires no root upload when targets hold their own operations', () => {
    const [shorthand, named] = schema.anyOf as { required: string[] }[];
    expect(shorthand?.required).toContain('upload');
    expect(named?.required).toEqual(['targets']);
  });

  it('says a write entry takes a variable, or the long form with a quoted mode', () => {
    const [shorthand] = schema.anyOf as { properties: Record<string, object> }[];
    expect(shorthand?.properties.write).toMatchObject({
      type: 'object',
      description: expect.stringContaining('secret'),
      additionalProperties: {
        anyOf: [
          { type: 'string' },
          {
            type: 'object',
            required: ['from'],
            additionalProperties: false,
            properties: {
              mode: { type: 'string', pattern: '^0?[0-7]{3}$' },
              allowPublic: { type: 'boolean' },
            },
          },
        ],
      },
    });
  });

  it('lets an ftps target pin its certificate with tlsFingerprint (R8)', () => {
    const [shorthand] = schema.anyOf as { properties: Record<string, object> }[];
    expect(shorthand?.properties.tlsFingerprint).toMatchObject({
      type: 'string',
      description: expect.stringContaining('SHA-256'),
    });
  });

  it('lets a target log in with a password or a private key (decision 0033)', () => {
    const shorthand = (
      schema.anyOf as { properties: Record<string, unknown>; required: string[] }[]
    )[0];
    expect(Object.keys(shorthand?.properties ?? {})).toEqual(
      expect.arrayContaining(['password', 'privateKey', 'passphrase']),
    );
    expect(shorthand?.required).not.toContain('password');
  });
});

describe('schema.json', () => {
  it('is what the config schema generates (run `npm run build` or `npm run schema`)', () => {
    expect(readFileSync(schemaFile, 'utf8')).toBe(schemaText());
  });
});
