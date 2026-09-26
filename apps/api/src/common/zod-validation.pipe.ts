import { BadRequestException, PipeTransform } from "@nestjs/common";
import { z } from "zod";

// zod 4's built-in issue messages describe the expectation, never the submitted
// value, so they are safe to return even for password fields. Custom schema
// messages must keep that property: never interpolate the input into them.
export class ZodValidationPipe<TSchema extends z.ZodType>
  implements PipeTransform<unknown, z.output<TSchema>>
{
  constructor(private readonly schema: TSchema) {}

  transform(value: unknown): z.output<TSchema> {
    const result = this.schema.safeParse(value);

    if (!result.success) {
      throw new BadRequestException(
        result.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`),
      );
    }

    return result.data;
  }
}
