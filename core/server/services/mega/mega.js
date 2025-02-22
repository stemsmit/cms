const _ = require('lodash');
const url = require('url');
const moment = require('moment');
const common = require('../../lib/common');
const membersService = require('../members');
const bulkEmailService = require('../bulk-email');
const models = require('../../models');
const postEmailSerializer = require('./post-email-serializer');
const config = require('../../config');

const getEmailData = async (postModel, members = []) => {
    const emailTmpl = await postEmailSerializer.serialize(postModel);
    emailTmpl.from = membersService.config.getEmailFromAddress();

    const EMAIL_REPLACEMENT_REGEX = /%%(\{.*?\})%%/g;
    // the &quot; is necessary here because `juice` will convert "->&quot; for email compatibility
    const REPLACEMENT_STRING_REGEX = /\{(?<memberProp>\w*?)(?:,? *(?:"|&quot;)(?<fallback>.*?)(?:"|&quot;))?\}/;
    const ALLOWED_REPLACEMENTS = ['subscriber_firstname'];

    // extract replacements with fallbacks. We have to handle replacements here because
    // it's the only place we have access to both member data and specified fallbacks
    const replacements = [];
    emailTmpl.html = emailTmpl.html.replace(EMAIL_REPLACEMENT_REGEX, (replacementMatch, replacementStr) => {
        const match = replacementStr.match(REPLACEMENT_STRING_REGEX);

        if (match) {
            const {memberProp, fallback} = match.groups;

            if (ALLOWED_REPLACEMENTS.includes(memberProp)) {
                const varName = `replacement_${replacements.length}`;

                replacements.push({
                    varName,
                    memberProp: memberProp.replace('subscriber_', ''),
                    fallback
                });
                return `%recipient.${varName}%`;
            }
        }

        // output the user-entered replacement string for unknown or invalid replacements
        // so that it's obvious there's an error in test emails
        return replacementStr;
    });

    // plaintext will have the same replacements so no need to add them to the list and
    // bloat the template variables object but we still need replacements for mailgun template syntax
    let count = 0;
    emailTmpl.plaintext = emailTmpl.plaintext.replace(EMAIL_REPLACEMENT_REGEX, (match, replacementStr) => {
        const {groups: {memberProp}} = replacementStr.match(REPLACEMENT_STRING_REGEX);
        if (ALLOWED_REPLACEMENTS.includes(memberProp)) {
            const varName = `replacement_${count}`;
            count = count + 1;
            return `%recipient.${varName}`;
        }
        return replacementStr;
    });

    const emails = [];
    const emailData = {};
    members.forEach((member) => {
        emails.push(member.email);

        // firstname is a computed property only used here for now
        // TODO: move into model computed property or output serializer?
        member.firstname = (member.name || '').split(' ')[0];

        // add static data to mailgun template variables
        const data = {
            unique_id: member.uuid,
            unsubscribe_url: postEmailSerializer.createUnsubscribeUrl(member.uuid)
        };

        // add replacement data/requested fallback to mailgun template variables
        replacements.forEach(({varName, memberProp, fallback}) => {
            data[varName] = member[memberProp] || fallback || '';
        });

        emailData[member.email] = data;
    });

    return {emailTmpl, emails, emailData};
};

const sendEmail = async (postModel, members) => {
    const membersToSendTo = members.filter((member) => {
        return membersService.contentGating.checkPostAccess(postModel.toJSON(), member);
    });

    const {emailTmpl, emails, emailData} = await getEmailData(postModel, membersToSendTo);

    return bulkEmailService.send(emailTmpl, emails, emailData);
};

const sendTestEmail = async (postModel, toEmails) => {
    const recipients = await Promise.all(toEmails.map(async (email) => {
        const member = await membersService.api.members.get({email});
        return member || {email};
    }));
    const {emailTmpl, emails, emailData} = await getEmailData(postModel, recipients);
    emailTmpl.subject = `[Test] ${emailTmpl.subject}`;
    return bulkEmailService.send(emailTmpl, emails, emailData);
};

/**
 * addEmail
 *
 * Accepts a post model and creates an email record based on it. Only creates one
 * record per post
 *
 * @param {object} postModel Post Model Object
 */

const addEmail = async (postModel, options) => {
    const knexOptions = _.pick(options, ['transacting', 'forUpdate']);

    const {members} = await membersService.api.members.list(Object.assign(knexOptions, {filter: 'subscribed:true'}, {limit: 'all'}));
    const membersToSendTo = members.filter((member) => {
        return membersService.contentGating.checkPostAccess(postModel.toJSON(), member);
    });
    const {emailTmpl, emails} = await getEmailData(postModel, membersToSendTo);

    // NOTE: don't create email object when there's nobody to send the email to
    if (!emails.length) {
        return null;
    }

    const postId = postModel.get('id');
    const existing = await models.Email.findOne({post_id: postId}, knexOptions);

    if (!existing) {
        return models.Email.add({
            post_id: postId,
            status: 'pending',
            email_count: emails.length,
            subject: emailTmpl.subject,
            html: emailTmpl.html,
            plaintext: emailTmpl.plaintext,
            submitted_at: moment().toDate()
        }, knexOptions);
    } else {
        return existing;
    }
};

/**
 * retryFailedEmail
 *
 * Accepts an Email model and resets it's fields to trigger retry listeners
 *
 * @param {object} model Email model
 */
const retryFailedEmail = async (model) => {
    return await models.Email.edit({
        status: 'pending'
    }, {
        id: model.get('id')
    });
};

/**
 * handleUnsubscribeRequest
 *
 * Takes a request/response pair and reads the `unsubscribe` query parameter,
 * using the content to update the members service to set the `subscribed` flag
 * to false on the member
 *
 * If any operation fails, or the request is invalid the function will error - so using
 * as middleware should consider wrapping with `try/catch`
 *
 * @param {Request} req
 * @returns {Promise<void>}
 */
async function handleUnsubscribeRequest(req) {
    if (!req.url) {
        throw new common.errors.BadRequestError({
            message: 'Unsubscribe failed! Could not find member'
        });
    }

    const {query} = url.parse(req.url, true);
    if (!query || !query.uuid) {
        throw new common.errors.BadRequestError({
            message: (query.preview ? 'Unsubscribe preview' : 'Unsubscribe failed! Could not find member')
        });
    }

    const member = await membersService.api.members.get({
        uuid: query.uuid
    });

    if (!member) {
        throw new common.errors.BadRequestError({
            message: 'Unsubscribe failed! Could not find member'
        });
    }

    try {
        return await membersService.api.members.update({subscribed: false}, {id: member.id});
    } catch (err) {
        throw new common.errors.InternalServerError({
            message: 'Failed to unsubscribe member'
        });
    }
}

function checkHostLimitForMembers(members = []) {
    const membersHostLimit = config.get('host_settings:limits:members');
    if (membersHostLimit) {
        const allowedMembersLimit = membersHostLimit.max;
        const hostUpgradeLink = config.get('host_settings:limits').upgrade_url;
        if (members.length > allowedMembersLimit) {
            throw new common.errors.HostLimitError({
                message: `Your current plan allows you to send email to up to ${allowedMembersLimit} members, but you currently have ${members.length} members`,
                help: hostUpgradeLink,
                errorDetails: {
                    limit: allowedMembersLimit,
                    total: members.length
                }
            });
        }
    }
}

async function pendingEmailHandler(emailModel, options) {
    // CASE: do not send email if we import a database
    // TODO: refactor post.published events to never fire on importing
    if (options && options.importing) {
        return;
    }
    const postModel = await models.Post.findOne({id: emailModel.get('post_id')}, {withRelated: ['authors']});

    if (emailModel.get('status') !== 'pending') {
        return;
    }

    const {members} = await membersService.api.members.list(Object.assign({filter: 'subscribed:true'}, {limit: 'all'}));

    if (!members.length) {
        return;
    }

    await models.Email.edit({
        status: 'submitting'
    }, {
        id: emailModel.id
    });

    let meta = [];
    let error = null;

    try {
        // Check host limit for allowed member count and throw error if over limit
        checkHostLimitForMembers(members);
        // NOTE: meta can contains an array which can be a mix of successful and error responses
        //       needs filtering and saving objects of {error, batchData} form to separate property
        meta = await sendEmail(postModel, members);
    } catch (err) {
        common.logging.error(new common.errors.GhostError({
            err: err,
            context: common.i18n.t('errors.services.mega.requestFailed.error')
        }));
        error = err.message;
    }

    const successes = meta.filter(response => (response instanceof bulkEmailService.SuccessfulBatch));
    const failures = meta.filter(response => (response instanceof bulkEmailService.FailedBatch));
    const batchStatus = successes.length ? 'submitted' : 'failed';

    if (!error && failures.length) {
        error = failures[0].error.message;
    }

    if (error && error.length > 2000) {
        error = error.substring(0, 2000);
    }

    try {
        // CASE: the batch partially succeeded
        await models.Email.edit({
            status: batchStatus,
            meta: JSON.stringify(successes),
            error: error,
            error_data: JSON.stringify(failures) // NOTE:need to discuss how we store this
        }, {
            id: emailModel.id
        });
    } catch (err) {
        common.logging.error(err);
    }
}

const statusChangedHandler = (emailModel, options) => {
    const emailRetried = emailModel.wasChanged()
        && emailModel.get('status') === 'pending'
        && emailModel.previous('status') === 'failed';

    if (emailRetried) {
        pendingEmailHandler(emailModel, options);
    }
};

function listen() {
    common.events.on('email.added', pendingEmailHandler);
    common.events.on('email.edited', statusChangedHandler);
}

// Public API
module.exports = {
    listen,
    addEmail,
    retryFailedEmail,
    sendTestEmail,
    handleUnsubscribeRequest
};
