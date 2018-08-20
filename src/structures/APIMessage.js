const DataResolver = require('../util/DataResolver');
const MessageEmbed = require('./MessageEmbed');
const MessageAttachment = require('./MessageAttachment');
const { browser } = require('../util/Constants');
const Util = require('../util/Util');
const { RangeError } = require('../errors');

/**
 * Represents a message to be sent to the API.
 */
class APIMessage {
  constructor(target, options) {
    /**
     * The target for this message to be sent to
     * @type {MessageTarget}
     */
    this.target = target;

    /**
     * Options passed in from send
     * @type {MessageOptions|WebhookMessageOptions}
     */
    this.options = options;
  }

  /**
   * Whether or not the target is a webhook.
   * @type {boolean}
   * @readonly
   */
  get isWebhook() {
    const Webhook = require('./Webhook');
    const WebhookClient = require('../client/WebhookClient');
    return this.target instanceof Webhook || this.target instanceof WebhookClient;
  }

  /**
   * Whether or not the target is a user.
   * @type {boolean}
   * @readonly
   */
  get isUser() {
    const User = require('./User');
    const GuildMember = require('./GuildMember');
    return this.target instanceof User || this.target instanceof GuildMember;
  }

  /**
   * Makes the content of this message.
   * @returns {string|string[]}
   */
  makeContent() { // eslint-disable-line complexity
    const GuildMember = require('./GuildMember');

    // eslint-disable-next-line eqeqeq
    let content = Util.resolveString(this.options.content == null ? '' : this.options.content);
    const isSplit = typeof this.options.split !== 'undefined' && this.options.split !== false;
    const isCode = typeof this.options.code !== 'undefined' && this.options.code !== false;
    const splitOptions = isSplit ? Object.assign({}, this.options.split) : undefined;

    let mentionPart = '';
    if (this.options.reply && !this.isUser && this.target.type !== 'dm') {
      const id = this.target.client.users.resolveID(this.options.reply);
      mentionPart = `<@${this.options.reply instanceof GuildMember && this.options.reply.nickname ? '!' : ''}${id}>, `;
      if (isSplit) {
        splitOptions.prepend = `${mentionPart}${splitOptions.prepend || ''}`;
      }
    }

    if (content || mentionPart) {
      if (isCode) {
        const codeName = typeof this.options.code === 'string' ? this.options.code : '';
        content = `${mentionPart}\`\`\`${codeName}\n${Util.escapeMarkdown(content, true)}\n\`\`\``;
        if (isSplit) {
          splitOptions.prepend = `${splitOptions.prepend || ''}\`\`\`${codeName}\n`;
          splitOptions.append = `\n\`\`\`${splitOptions.append || ''}`;
        }
      } else if (mentionPart) {
        content = `${mentionPart}${content}`;
      }

      const disableEveryone = typeof this.options.disableEveryone === 'undefined' ?
        this.target.client.options.disableEveryone :
        this.options.disableEveryone;
      if (disableEveryone) {
        content = content.replace(/@(everyone|here)/g, '@\u200b$1');
      }

      if (isSplit) {
        content = Util.splitMessage(content, splitOptions);
      }
    }

    return content;
  }

  /**
   * Resolves data.
   * @returns {Object}
   */
  resolveData() {
    const content = this.makeContent();
    const tts = Boolean(this.options.tts);
    let nonce;
    if (typeof this.options.nonce !== 'undefined') {
      nonce = parseInt(this.options.nonce);
      if (isNaN(nonce) || nonce < 0) throw new RangeError('MESSAGE_NONCE_TYPE');
    }

    const embedLikes = [];
    if (this.isWebhook) {
      if (this.options.embeds) {
        embedLikes.push(...this.options.embeds);
      }
    } else if (this.options.embed) {
      embedLikes.push(this.options.embed);
    }
    const embeds = embedLikes.map(e => new MessageEmbed(e)._apiTransform());

    let username;
    let avatarURL;
    if (this.isWebhook) {
      username = this.options.username || this.target.name;
      if (this.options.avatarURL) avatarURL = this.options.avatarURL;
    }

    return {
      content,
      tts,
      nonce,
      embed: this.options.embed === null ? null : embeds[0],
      embeds,
      username,
      avatar_url: avatarURL,
    };
  }

  /**
   * Resolves files.
   * @returns {Promise<Object[]>}
   */
  resolveFiles() {
    const embedLikes = [];
    if (this.isWebhook) {
      if (this.options.embeds) {
        embedLikes.push(...this.options.embeds);
      }
    } else if (this.options.embed) {
      embedLikes.push(this.options.embed);
    }

    const fileLikes = [];
    if (this.options.files) {
      fileLikes.push(...this.options.files);
    }
    for (const embed of embedLikes) {
      if (embed.files) {
        fileLikes.push(...embed.files);
      }
    }

    return Promise.all(fileLikes.map(f => this.constructor.resolveFile(f)));
  }

  /**
   * Resolves a single file into an object sendable to the API.
   * @param {BufferResolvable|Stream|FileOptions|MessageAttachment} fileLike Something that could be resolved to a file
   * @returns {Object}
   */
  static async resolveFile(fileLike) {
    let attachment;
    let name;

    const findName = thing => {
      if (typeof thing === 'string') {
        return Util.basename(thing);
      }

      if (thing.path) {
        return Util.basename(thing.path);
      }

      return 'file.jpg';
    };

    const ownAttachment = typeof fileLike === 'string' ||
      fileLike instanceof (browser ? ArrayBuffer : Buffer) ||
      typeof fileLike.pipe === 'function';
    if (ownAttachment) {
      attachment = fileLike;
      name = findName(attachment);
    } else {
      attachment = fileLike.attachment;
      name = fileLike.name || findName(attachment);
    }

    const resource = await DataResolver.resolveFile(attachment);
    return { attachment, name, file: resource };
  }

  /**
   * Partitions embeds and attachments.
   * @param {Array<MessageEmbed|MessageAttachment>} items Items to partition
   * @returns {Array<MessageEmbed[], MessageAttachment[]>}
   */
  static partitionMessageAdditions(items) {
    const embeds = [];
    const files = [];
    for (const item of items) {
      if (item instanceof MessageEmbed) {
        embeds.push(item);
      } else if (item instanceof MessageAttachment) {
        files.push(item);
      }
    }

    return [embeds, files];
  }

  /**
   * Transforms the user-level arguments into a final options object. Passing a transformed options object alone into
   * this method will keep it the same, allowing for the reuse of the final options object.
   * @param {StringResolvable} [content=''] Content to send
   * @param {MessageOptions|WebhookMessageOptions|MessageAdditions} [options={}] Options to use
   * @param {MessageOptions|WebhookMessageOptions} [extra={}] Extra options to add onto transformed options
   * @param {boolean} [isWebhook=false] Whether or not to use WebhookMessageOptions as the result
   * @returns {MessageOptions|WebhookMessageOptions}
   */
  static transformOptions(content, options, extra = {}, isWebhook = false) {
    if (!options && typeof content === 'object' && !(content instanceof Array)) {
      options = content;
      content = '';
    }

    if (!options) {
      options = {};
    }

    if (options instanceof MessageEmbed) {
      return Object.assign(isWebhook ? { content, embeds: [options] } : { content, embed: options }, extra);
    }

    if (options instanceof MessageAttachment) {
      return Object.assign({ content, files: [options] }, extra);
    }

    if (options instanceof Array) {
      const [embeds, files] = this.partitionMessageAdditions(options);
      return Object.assign(isWebhook ? { content, embeds, files } : { content, embed: embeds[0], files }, extra);
    } else if (content instanceof Array) {
      const [embeds, files] = this.partitionMessageAdditions(content);
      if (embeds.length || files.length) {
        return Object.assign(isWebhook ? { embeds, files } : { embed: embeds[0], files }, extra);
      }
    }

    return Object.assign({ content }, options, extra);
  }

  /**
   * Creates an `APIMessage` from user-level arguments.
   * @param {MessageTarget} target Target to send to
   * @param {StringResolvable} [content=''] Content to send
   * @param {MessageOptions|WebhookMessageOptions|MessageAdditions} [options={}] Options to use
   * @param {MessageOptions|WebhookMessageOptions} [extra={}] - Extra options to add onto transformed options
   * @returns {MessageOptions|WebhookMessageOptions}
   */
  static create(target, content, options, extra = {}) {
    const Webhook = require('./Webhook');
    const WebhookClient = require('../client/WebhookClient');

    const isWebhook = target instanceof Webhook || target instanceof WebhookClient;
    const transformed = this.transformOptions(content, options, extra, isWebhook);
    return new this(target, transformed);
  }
}

module.exports = APIMessage;

/**
 * A target for a message.
 * @typedef {TextChannel|DMChannel|GroupDMChannel|User|GuildMember|Webhook|WebhookClient} MessageTarget
 */

/**
 * Additional items that can be sent with a message.
 * @typedef {MessageEmbed|MessageAttachment|Array<MessageEmbed|MessageAttachment>} MessageAdditions
 */
