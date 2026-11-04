/**
 * A column section's heading: the plain name while the list is still loading (`total` undefined),
 * then "Name (total)", or "Name (shown of total)" while the filter is active.
 */
export const sectionCountLabel = (
  name: string,
  shown: number,
  total: number | undefined,
  filtering: boolean,
): string => {
  if (total === undefined) return name;
  return filtering ? `${name} (${shown} of ${total})` : `${name} (${total})`;
};
