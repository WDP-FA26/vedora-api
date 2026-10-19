import { z } from 'zod';

/**
 * The fields we read from a Cloudinary notification. `upload` carries the
 * video's details; `eager` reports the HLS job, one item per transformation.
 * Unknown types (delete, rename, …) pass through and are ignored.
 */
export const cloudinaryNotification = z.looseObject({
  notification_type: z.string(),
  public_id: z.string().optional(),
  resource_type: z.string().optional(),
  duration: z.number().optional(),
  width: z.number().optional(),
  height: z.number().optional(),
  video: z.looseObject({ dar: z.string().optional() }).optional(),
  eager: z
    .array(
      z.looseObject({
        transformation: z.string().optional(),
        status: z.string().optional(),
        error: z.unknown().optional(),
      }),
    )
    .optional(),
});

export type CloudinaryNotification = z.infer<typeof cloudinaryNotification>;
