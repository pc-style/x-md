import { feature, item, plan } from 'atmn';

// Features
export const social_credits = feature({
	id: 'social_credits',
	name: 'Social Credits',
	type: 'metered',
	consumable: true,
});

export const obsidian_templates = feature({
	id: 'obsidian_templates',
	name: 'Obsidian Social Note Templates',
	type: 'boolean',
});

export const quote_expansion = feature({
	id: 'quote_expansion',
	name: 'Quote Expansion',
	type: 'boolean',
});

export const json_ld_basic_export = feature({
	id: 'json_ld_basic_export',
	name: 'JSON-LD Basic Export',
	type: 'boolean',
});

export const thread_briefing = feature({
	id: 'thread_briefing',
	name: 'Thread Briefing and Author Dossiers',
	type: 'boolean',
});

export const cross_platform_parser = feature({
	id: 'cross_platform_parser',
	name: 'Cross-Platform Parser',
	type: 'boolean',
});

export const context_window_safe_mode = feature({
	id: 'context_window_safe_mode',
	name: 'Context-Window Safe Mode',
	type: 'boolean',
});

export const bulk_json_ld_export = feature({
	id: 'bulk_json_ld_export',
	name: 'Bulk JSON-LD Archive Export',
	type: 'boolean',
});

export const markdown_export = feature({
	id: 'markdown_export',
	name: 'Markdown Export',
	type: 'boolean',
});

export const api_commercial_use = feature({
	id: 'api_commercial_use',
	name: 'API/Commercial Use',
	type: 'boolean',
});

// Plans
export const free = plan({
	id: 'free',
	name: 'Free',
	autoEnable: true,
	items: [
		item({
			featureId: markdown_export.id,
			included: 0,
		}),
	],
});

export const starter = plan({
	id: 'starter',
	name: 'Starter',
	price: {
		amount: 5,
		interval: 'month',
	},
	items: [
		item({
			featureId: json_ld_basic_export.id,
			included: 0,
		}),
		item({
			featureId: markdown_export.id,
			included: 0,
		}),
		item({
			featureId: obsidian_templates.id,
			included: 0,
		}),
		item({
			featureId: quote_expansion.id,
			included: 0,
		}),
		item({
			featureId: social_credits.id,
			included: 250,
			reset: {
				interval: 'month',
			},
		}),
	],
});

export const pro = plan({
	id: 'pro',
	name: 'Pro',
	price: {
		amount: 15,
		interval: 'month',
	},
	items: [
		item({
			featureId: api_commercial_use.id,
			included: 0,
		}),
		item({
			featureId: bulk_json_ld_export.id,
			included: 0,
		}),
		item({
			featureId: context_window_safe_mode.id,
			included: 0,
		}),
		item({
			featureId: cross_platform_parser.id,
			included: 0,
		}),
		item({
			featureId: json_ld_basic_export.id,
			included: 0,
		}),
		item({
			featureId: markdown_export.id,
			included: 0,
		}),
		item({
			featureId: obsidian_templates.id,
			included: 0,
		}),
		item({
			featureId: quote_expansion.id,
			included: 0,
		}),
		item({
			featureId: social_credits.id,
			included: 1500,
			reset: {
				interval: 'month',
			},
		}),
		item({
			featureId: thread_briefing.id,
			included: 0,
		}),
	],
});

export const credit_top_up = plan({
	id: 'credit_top_up',
	name: 'Credit Top-Up',
	addOn: true,
	items: [
		item({
			featureId: social_credits.id,
			included: 0,
			price: {
				amount: 5,
				billingUnits: 500,
				billingMethod: 'prepaid',
				interval: 'one_off',
			},
		}),
	],
});
