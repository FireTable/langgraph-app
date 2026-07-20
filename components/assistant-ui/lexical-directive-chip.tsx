import { FC } from "react";
import { DirectiveChipSpan } from "./directive-chip";

type DirectiveChipProps = {
  directiveId: string;
  directiveType: string;
  label: string;
};

export const LexicalDirectiveChip: FC<DirectiveChipProps> = ({
  directiveId,
  directiveType,
  label,
}) => {
  return (
    <DirectiveChipSpan directiveType={directiveType} label={label} directiveId={directiveId} />
  );
};
