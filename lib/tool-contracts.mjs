export function toolError(code, message, suggestion, details = {}) {
  return Object.assign(new Error(message), { code, suggestion, details });
}

export function validateToolArguments(definition, args) {
  function invalid(field, message) {
    throw toolError('INVALID_ARGUMENTS', `${field} ${message}`, 'Correct the arguments using the tool schema, then retry.');
  }
  function validate(schema, value, field) {
    if (schema.type === 'object') {
      if (!value || typeof value !== 'object' || Array.isArray(value)) invalid(field, 'must be an object.');
      for (const key of schema.required || []) {
        if (!Object.hasOwn(value, key)) invalid(field === 'arguments' ? key : `${field}.${key}`, 'is required.');
      }
      for (const [key, item] of Object.entries(value)) {
        const child = Object.hasOwn(schema.properties || {}, key) ? schema.properties[key] : null;
        if (!child && schema.additionalProperties === false) invalid(`${field}.${key}`, 'is not a supported argument.');
        if (child) validate(child, item, `${field}.${key}`);
      }
    } else if (schema.type === 'array') {
      if (!Array.isArray(value)) invalid(field, 'must be an array.');
      if (schema.minItems !== undefined && value.length < schema.minItems) invalid(field, `must contain at least ${schema.minItems} items.`);
      if (schema.maxItems !== undefined && value.length > schema.maxItems) invalid(field, `must contain at most ${schema.maxItems} items.`);
      value.forEach((item, index) => validate(schema.items, item, `${field}[${index}]`));
    } else if (schema.type === 'integer') {
      if (!Number.isSafeInteger(value)) invalid(field, 'must be an integer.');
      if (schema.minimum !== undefined && value < schema.minimum) invalid(field, `must be at least ${schema.minimum}.`);
      if (schema.maximum !== undefined && value > schema.maximum) invalid(field, `must be at most ${schema.maximum}.`);
    } else if (typeof value !== schema.type) {
      invalid(field, `must be a ${schema.type}.`);
    }
    if (typeof value === 'string') {
      if (schema.minLength !== undefined && value.length < schema.minLength) invalid(field, 'must not be empty.');
      if (schema.maxLength !== undefined && value.length > schema.maxLength) invalid(field, `exceeds the ${schema.maxLength} character limit.`);
    }
    if (schema.enum && !schema.enum.includes(value)) invalid(field, `must be one of: ${schema.enum.join(', ')}.`);
  }
  validate(definition.function.parameters, args, 'arguments');
  return args;
}

export function toolFailure(error, fallbackCode = 'TOOL_ERROR', workspaceRoot = '') {
  const hints = {
    ENOENT: 'Use list_directory or find_files to confirm the path. To create a new file, use write_file with expected_sha256 set to an empty string.',
    EISDIR: 'Use list_directory for directories, or choose a file path.',
    ENOTDIR: 'Check the parent path with list_directory.',
    EACCES: 'The operating system refused access. Report the affected path and permission issue.',
    EPERM: 'The operating system refused this operation. Report the affected path and permission issue.',
    SANDBOX_VIOLATION: 'Use a path relative to the selected workspace. Files outside it are unavailable.'
  };
  let message = error.message || String(error);
  if (workspaceRoot) message = message.split(workspaceRoot).join('.');
  return {
    ok: false,
    code: error.code || fallbackCode,
    error: message,
    suggestion: error.suggestion || hints[error.code] || 'Inspect the error and current file state before retrying. Do not repeat the same failed call unchanged.',
    ...(error.details && Object.keys(error.details).length ? { details: error.details } : {})
  };
}
