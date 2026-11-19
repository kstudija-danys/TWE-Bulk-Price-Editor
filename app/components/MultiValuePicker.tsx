import { useMemo, useState } from "react";
import { Combobox, Listbox, InlineStack, Tag, BlockStack, Text } from "@shopify/polaris";

const MAX_SUGGESTIONS = 50;

/**
 * Multi-select with type-ahead over a list of known values (e.g. the store's
 * product tags). Values not in the list can still be added with Enter, so a
 * missing or truncated list never blocks the user.
 */
export function MultiValuePicker({
  label,
  options,
  selected,
  onChange,
  placeholder,
  helpText,
}: {
  label: string;
  options: string[];
  selected: string[];
  onChange: (values: string[]) => void;
  placeholder?: string;
  helpText?: string;
}) {
  const [input, setInput] = useState("");

  const suggestions = useMemo(() => {
    const q = input.trim().toLowerCase();
    const chosen = new Set(selected.map((s) => s.toLowerCase()));
    return options
      .filter((o) => !chosen.has(o.toLowerCase()) && (!q || o.toLowerCase().includes(q)))
      .slice(0, MAX_SUGGESTIONS);
  }, [input, options, selected]);

  function add(value: string) {
    const v = value.trim();
    if (!v || selected.some((s) => s.toLowerCase() === v.toLowerCase())) return;
    // Use the store's spelling when the typed value matches one case-insensitively.
    const known = options.find((o) => o.toLowerCase() === v.toLowerCase());
    onChange([...selected, known ?? v]);
    setInput("");
  }

  const typedIsUnknown =
    input.trim() !== "" &&
    !options.some((o) => o.toLowerCase() === input.trim().toLowerCase());

  return (
    <BlockStack gap="100">
      <Combobox
        allowMultiple
        activator={
          <Combobox.TextField
            label={label}
            value={input}
            onChange={setInput}
            placeholder={placeholder}
            helpText={helpText}
            autoComplete="off"
          />
        }
      >
        {suggestions.length > 0 || typedIsUnknown ? (
          <Listbox onSelect={add}>
            {typedIsUnknown && (
              <Listbox.Action value={input.trim()}>{`Add "${input.trim()}"`}</Listbox.Action>
            )}
            {suggestions.map((o) => (
              <Listbox.Option key={o} value={o}>
                {o}
              </Listbox.Option>
            ))}
          </Listbox>
        ) : null}
      </Combobox>
      {selected.length > 0 ? (
        <InlineStack gap="100">
          {selected.map((s) => (
            <Tag key={s} onRemove={() => onChange(selected.filter((x) => x !== s))}>
              {s}
            </Tag>
          ))}
        </InlineStack>
      ) : null}
      {typedIsUnknown && options.length > 0 && (
        <Text as="span" variant="bodySm" tone="caution">
          "{input.trim()}" isn't used on any product yet — it will match nothing.
        </Text>
      )}
    </BlockStack>
  );
}
