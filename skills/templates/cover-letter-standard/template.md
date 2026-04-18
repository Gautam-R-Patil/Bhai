{{#if author}}**{{author}}**{{/if}}{{#if metadata.authorEmail}}  
{{metadata.authorEmail}}{{/if}}{{#if metadata.authorPhone}}  
{{metadata.authorPhone}}{{/if}}{{#if metadata.authorAddress}}  
{{metadata.authorAddress}}{{/if}}

{{#if date}}{{date}}{{/if}}

{{#if recipient.name}}{{recipient.name}}  
{{/if}}{{#if recipient.title}}{{recipient.title}}  
{{/if}}{{#if recipient.company}}{{recipient.company}}  
{{/if}}{{#if recipient.address}}{{recipient.address}}{{/if}}

{{#if metadata.salutation}}{{metadata.salutation}},{{else}}Dear {{#if recipient.name}}{{recipient.name}}{{else}}Hiring Manager{{/if}},{{/if}}

{{{body}}}

{{#if metadata.closing}}{{metadata.closing}},{{else}}Sincerely,{{/if}}

{{author}}
