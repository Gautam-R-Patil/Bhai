# {{title}}

{{#if subtitle}}*{{subtitle}}*

{{/if}}{{#if author}}**{{author}}**{{#if date}} · {{date}}{{/if}}

{{/if}}{{#unless author}}{{#if date}}*{{date}}*

{{/if}}{{/unless}}---

{{{body}}}
