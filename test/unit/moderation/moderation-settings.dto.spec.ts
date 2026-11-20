import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { describe, expect, it } from 'vitest';
import {
  ModerationChoiceDto,
  ModerationPolicyDto,
  ModerationSettingsDto,
  ModerationTestResultDto,
  TestModerationDto,
  UpdateModerationSettingsDto,
} from '../../../src/moderation/dto/moderation-settings.dto.js';

function validChoice(overrides: Record<string, unknown> = {}) {
  return {
    key: 'violence',
    label: 'Bạo lực',
    reasonText: 'bạo lực hoặc đe dọa',
    description: 'Graphic gore, injury, or credible threats of harm.',
    ...overrides,
  };
}

function validPolicy(overrides: Record<string, unknown> = {}) {
  return {
    instructions: 'Classify content posted on Vedora for safety only.',
    allowDescription: 'Cooking recipes, food photos, and everyday chatter.',
    choices: [validChoice()],
    rejectThreshold: 0.85,
    reviewThreshold: 0.3,
    ...overrides,
  };
}

describe('moderation-settings.dto', () => {
  describe('ModerationChoiceDto', () => {
    it('trims label, reasonText, and description before validation', async () => {
      const dto = plainToInstance(
        ModerationChoiceDto,
        validChoice({
          label: '  Bạo lực  ',
          reasonText: '  bạo lực hoặc đe dọa  ',
          description: '  Graphic gore, injury, or credible threats of harm.  ',
        }),
      );

      expect(dto.label).toBe('Bạo lực');
      expect(dto.reasonText).toBe('bạo lực hoặc đe dọa');
      expect(dto.description).toBe(
        'Graphic gore, injury, or credible threats of harm.',
      );
      await expect(validate(dto)).resolves.toHaveLength(0);
    });

    it('rejects non-string values without crashing trim transform', async () => {
      const dto = plainToInstance(
        ModerationChoiceDto,
        validChoice({
          key: 123,
          label: 456,
          reasonText: null,
          description: ['not-a-string'],
        }),
      );

      const errors = await validate(dto);
      expect(errors.map((e) => e.property).sort()).toEqual([
        'description',
        'key',
        'label',
        'reasonText',
      ]);
    });

    it.each(['allow', 'a', '1abc', 'BadKey', 'bad-key', 'a'.repeat(33)])(
      'rejects invalid choice key %s',
      async (key) => {
        const dto = plainToInstance(ModerationChoiceDto, validChoice({ key }));
        const errors = await validate(dto);
        expect(errors.some((e) => e.property === 'key')).toBe(true);
      },
    );

    it('enforces length bounds after trimming', async () => {
      const dto = plainToInstance(
        ModerationChoiceDto,
        validChoice({
          label: '   ',
          reasonText: ' ab ',
          description: '  short  ',
        }),
      );
      const errors = await validate(dto);
      expect(errors.map((e) => e.property).sort()).toEqual([
        'description',
        'label',
        'reasonText',
      ]);
    });
  });

  describe('ModerationPolicyDto', () => {
    it('accepts a valid policy with trimmed instructions and allowDescription', async () => {
      const dto = plainToInstance(
        ModerationPolicyDto,
        validPolicy({
          instructions:
            '  Classify content posted on Vedora for safety only.  ',
          allowDescription:
            '  Cooking recipes, food photos, and everyday chatter.  ',
        }),
      );

      expect(dto.instructions).toBe(
        'Classify content posted on Vedora for safety only.',
      );
      expect(dto.allowDescription).toBe(
        'Cooking recipes, food photos, and everyday chatter.',
      );
      await expect(validate(dto)).resolves.toHaveLength(0);
    });

    it('rejects duplicate choice keys and out-of-range choice array sizes', async () => {
      const duplicate = plainToInstance(
        ModerationPolicyDto,
        validPolicy({
          choices: [validChoice({ key: 'spam' }), validChoice({ key: 'spam' })],
        }),
      );
      expect(
        (await validate(duplicate)).some((e) => e.property === 'choices'),
      ).toBe(true);

      const empty = plainToInstance(
        ModerationPolicyDto,
        validPolicy({ choices: [] }),
      );
      expect(
        (await validate(empty)).some((e) => e.property === 'choices'),
      ).toBe(true);

      const tooMany = plainToInstance(
        ModerationPolicyDto,
        validPolicy({
          choices: Array.from({ length: 17 }, (_, i) =>
            validChoice({ key: `cat_${i}` }),
          ),
        }),
      );
      expect(
        (await validate(tooMany)).some((e) => e.property === 'choices'),
      ).toBe(true);
    });

    it('requires reviewThreshold strictly below rejectThreshold within [0, 1]', async () => {
      const equal = plainToInstance(
        ModerationPolicyDto,
        validPolicy({ reviewThreshold: 0.5, rejectThreshold: 0.5 }),
      );
      const equalErrors = await validate(equal);
      expect(
        equalErrors.find((e) => e.property === 'reviewThreshold')?.constraints,
      ).toMatchObject({
        belowRejectThreshold:
          'reviewThreshold must be lower than rejectThreshold',
      });

      const higher = plainToInstance(
        ModerationPolicyDto,
        validPolicy({ reviewThreshold: 0.9, rejectThreshold: 0.8 }),
      );
      expect(
        (await validate(higher)).some((e) => e.property === 'reviewThreshold'),
      ).toBe(true);

      const nonNumericReject = plainToInstance(
        ModerationPolicyDto,
        validPolicy({ reviewThreshold: 0.3, rejectThreshold: '0.85' }),
      );
      expect(
        (await validate(nonNumericReject)).some(
          (e) => e.property === 'reviewThreshold',
        ),
      ).toBe(true);

      const outOfBounds = plainToInstance(
        ModerationPolicyDto,
        validPolicy({ reviewThreshold: -0.1, rejectThreshold: 1.1 }),
      );
      expect(
        (await validate(outOfBounds)).map((e) => e.property).sort(),
      ).toEqual(['rejectThreshold', 'reviewThreshold']);
    });

    it('validates nested choices', async () => {
      const dto = plainToInstance(
        ModerationPolicyDto,
        validPolicy({ choices: [validChoice({ key: 'allow' })] }),
      );
      const errors = await validate(dto);
      expect(errors.some((e) => e.property === 'choices')).toBe(true);
    });
  });

  describe('UpdateModerationSettingsDto and TestModerationDto', () => {
    it('validates integer non-negative version on update', async () => {
      const valid = plainToInstance(UpdateModerationSettingsDto, {
        ...validPolicy(),
        version: 0,
      });
      await expect(validate(valid)).resolves.toHaveLength(0);

      const negative = plainToInstance(UpdateModerationSettingsDto, {
        ...validPolicy(),
        version: -1,
      });
      expect(
        (await validate(negative)).some((e) => e.property === 'version'),
      ).toBe(true);

      const fractional = plainToInstance(UpdateModerationSettingsDto, {
        ...validPolicy(),
        version: 1.5,
      });
      expect(
        (await validate(fractional)).some((e) => e.property === 'version'),
      ).toBe(true);
    });

    it('validates TestModerationDto with and without draft settings', async () => {
      const simple = plainToInstance(TestModerationDto, { text: 'hello' });
      await expect(validate(simple)).resolves.toHaveLength(0);

      const tooLong = plainToInstance(TestModerationDto, {
        text: 'a'.repeat(5001),
      });
      expect((await validate(tooLong)).some((e) => e.property === 'text')).toBe(
        true,
      );

      const invalidDraft = plainToInstance(TestModerationDto, {
        text: 'hello',
        settings: validPolicy({ instructions: 'too short' }),
      });
      expect(
        (await validate(invalidDraft)).some((e) => e.property === 'settings'),
      ).toBe(true);
    });

    it('constructs response DTOs', () => {
      const settings = plainToInstance(ModerationSettingsDto, {
        ...validPolicy(),
        version: 1,
        updatedAt: new Date(),
        updatedById: 'admin-1',
        isDefault: false,
      });
      const result = plainToInstance(ModerationTestResultDto, {
        decision: 'publish',
        category: null,
        violationScore: 0.05,
        scores: { allow: 0.95, violence: 0.05 },
      });

      expect(settings).toBeInstanceOf(ModerationSettingsDto);
      expect(result).toBeInstanceOf(ModerationTestResultDto);
    });
  });
});
