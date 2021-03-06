import mongodb, { ObjectID } from "mongodb";
import discord, { Message, MessageEmbed, User, Client, GuildMember } from "discord.js";
import moment from "moment-timezone";
import "moment-recur-ts";

import db from "../db";
import aux from "../appaux";
import ShardManager, { ShardGuild, ShardMember, ShardChannel, ShardUser } from "../processes/shard-manager";
import { io } from "../processes/socket";
import { GuildConfig } from "./guild-config";
import { GameRSVP } from "./game-signups";
import config from "./config";
import cloneDeep from "lodash/cloneDeep";
import { isObject } from "lodash";

const connection = db.connection;
const ObjectId = mongodb.ObjectId;
const collection = "games";
const host = process.env.HOST;

const supportedLanguages = require("../../lang/langs.json");
const gmLanguages = supportedLanguages.langs
  .map((lang: String) => {
    return {
      code: lang,
      ...require(`../../lang/${lang}.json`),
    };
  })
  .sort((a: any, b: any) => (a.name > b.name ? 1 : -1));

export enum Frequency {
  NO_REPEAT = 0,
  DAILY = 1,
  WEEKLY = 2,
  BIWEEKLY = 3,
  MONTHLY = 4,
}

export enum MonthlyType {
  WEEKDAY = "weekday",
  DATE = "date",
}

export enum GameMethod {
  AUTOMATED = "automated",
  CUSTOM = "custom",
}

export enum GameWhen {
  DATETIME = "datetime",
  NOW = "now",
}

export enum RescheduleMode {
  REPOST = "repost",
  UPDATE = "update",
}

export interface RSVP {
  _id?: string | number | ObjectID;
  gameId?: string | number | ObjectID;
  id?: string;
  tag: string;
  timestamp?: number;
}

export interface GameModel {
  _id: string | number | ObjectID;
  s: string;
  c: string;
  guild: string;
  channel: string;
  template: string | number | ObjectID;
  adventure: string;
  runtime: string;
  duration: number;
  minPlayers: string;
  players: string;
  dm: RSVP;
  author: RSVP;
  reserved: RSVP[];
  where: string;
  description: string;
  method: GameMethod;
  customSignup: string;
  when: GameWhen;
  date: string;
  time: string;
  timezone: number;
  tz: string;
  timestamp: number;
  hideDate: boolean;
  reminder: string;
  reminded: boolean;
  messageId: string;
  reminderMessageId: string;
  pm: string;
  gameImage: string;
  thumbnail: string;
  frequency: Frequency;
  weekdays: boolean[];
  xWeeks: number;
  monthlyType: MonthlyType;
  clearReservedOnRepeat: boolean;
  disableWaitlist: boolean;
  rescheduled: boolean;
  pastSignups: boolean;
  sequence: number;
  pruned?: boolean;
  deleted?: boolean;
  createdTimestamp: number;
  updatedTimestamp: number;
}

interface GameSaveData {
  _id: string | number | ObjectID;
  message: Message;
  modified: boolean;
}

interface GameSaveOptions {
  force?: boolean;
  user?: any;
  repost?: boolean;
}

export enum GameReminder {
  NO_REMINDER = "0",
  MINUTES_15 = "15",
  MINUTES_30 = "30",
  MINUTES_60 = "60",
  HOURS_6 = "360",
  HOURS_12 = "720",
  HOURS_24 = "1440",
}

export const gameReminderOptions = [GameReminder.MINUTES_15, GameReminder.MINUTES_30, GameReminder.MINUTES_60, GameReminder.HOURS_6, GameReminder.HOURS_12, GameReminder.HOURS_24];

export class Game implements GameModel {
  _id: string | number | ObjectID;
  s: string;
  c: string;
  guild: string;
  channel: string;
  template: string | number | ObjectID;
  adventure: string;
  runtime: string;
  duration: number;
  minPlayers: string;
  players: string;
  dm: RSVP;
  author: RSVP;
  reserved: RSVP[];
  where: string;
  description: string;
  method: GameMethod;
  customSignup: string;
  when: GameWhen;
  date: string;
  time: string;
  timezone: number;
  tz: string;
  timestamp: number;
  hideDate: boolean;
  reminder: string;
  reminded: boolean;
  messageId: string;
  reminderMessageId: string;
  pm: string;
  gameImage: string;
  thumbnail: string;
  frequency: Frequency;
  weekdays: boolean[] = [false, false, false, false, false, false, false];
  xWeeks: number = 2;
  monthlyType: MonthlyType = MonthlyType.WEEKDAY;
  clearReservedOnRepeat: boolean = false;
  disableWaitlist: boolean = false;
  rescheduled: boolean = false;
  pastSignups: boolean = false;
  sequence: number = 1;
  pruned: boolean = false;
  deleted: boolean = false;
  createdTimestamp: number;
  updatedTimestamp: number;
  slot: number = 0;

  client: Client;
  guilds: ShardGuild[] = [];

  constructor(game: GameModel, guilds: ShardGuild[], client?: Client) {
    if (client) this.client = client;
    if (guilds) this.guilds = guilds;

    let guildMembers: ShardMember[] = [];
    const gameEntries = Object.entries(game || {});
    for (let i = 0; i < gameEntries.length; i++) {
      let [key, value] = gameEntries[i];

      // Strip HTML Tags from Data
      if (typeof value === "string") {
        value = value.replace(/<\/?(\w+)((\s+\w+(\s*=\s*(?:".*?"|'.*?'|[\^'">\s]+))?)+\s*|\s*)\/?>/gm, "");
      }

      if (key === "s") {
        this[key] = value;
        this._guild = guilds.find((g) => g.id === value);
        if (this._guild && !guildMembers.length) guildMembers = this._guild.members;
      } else if (key === "c" && this._guild) {
        this[key] = value;
        this._guild.channels.forEach((c) => {
          if (!this._channel && c.type === "text") {
            this._channel = c;
          }
          if (c.id === value && (c.type === "text" || c.type === "news")) {
            this._channel = c;
          }
        });
      } else if (key === "dm" && guildMembers) {
        this[key] = Game.updateDM(value, guildMembers);
      } else this[key] = value;
    }

    if (!this.author) this.author = this.dm;

    const d = new Date();
    d.setDate(d.getDate() - 2);
    if (!this.createdTimestamp) {
      this.createdTimestamp = d.getTime() - 24 * 3600 * 1000;
    }
    if (!this.updatedTimestamp) this.updatedTimestamp = this.createdTimestamp;
  }

  private _guild: ShardGuild;
  get discordGuild() {
    return this._guild;
  }

  set discordGuild(guild: ShardGuild) {
    this._guild = guild;
    if (guild)
      this._guild.channels.forEach((c) => {
        if (!this._channel && c.type === "text") {
          this._channel = c;
        }
        if (c.id === this.c && (c.type === "text" || c.type === "news")) {
          this._channel = c;
        }
      });
  }

  private _channel: ShardChannel;
  get discordChannel() {
    return this._channel;
  }

  get data(): GameModel {
    return {
      _id: this._id,
      s: this.s,
      c: this.c,
      guild: this.guild,
      channel: this.channel,
      template: this.template,
      adventure: this.adventure,
      runtime: this.runtime,
      duration: this.duration,
      minPlayers: this.minPlayers,
      players: this.players,
      dm: this.dm,
      author: this.author,
      reserved: this.reserved,
      where: this.where,
      description: this.description,
      method: this.method,
      customSignup: this.customSignup,
      when: this.when,
      date: this.date,
      time: this.time,
      timezone: this.timezone,
      tz: this.tz,
      timestamp: this.timestamp,
      hideDate: this.hideDate,
      reminder: this.reminder,
      reminded: this.reminded,
      messageId: this.messageId,
      reminderMessageId: this.reminderMessageId,
      pm: this.pm,
      gameImage: this.gameImage,
      thumbnail: this.thumbnail,
      frequency: this.frequency,
      weekdays: this.weekdays,
      xWeeks: this.xWeeks,
      monthlyType: this.monthlyType,
      clearReservedOnRepeat: this.clearReservedOnRepeat,
      disableWaitlist: this.disableWaitlist,
      rescheduled: this.rescheduled,
      pastSignups: this.pastSignups,
      sequence: this.sequence,
      pruned: this.pruned,
      deleted: this.deleted,
      createdTimestamp: this.createdTimestamp,
      updatedTimestamp: this.updatedTimestamp,
    };
  }

  async save(options: GameSaveOptions = {}) {
    if (!connection()) {
      aux.log("No database connection");
      return null;
    }

    let game: GameModel = cloneDeep(this.data);

    try {
      let channel = this._channel;
      let guild = this._guild;

      if (!guild) {
        if (this.client) {
          const sGuilds = await ShardManager.clientGuilds(this.client, [game.s]);
          guild = sGuilds.find((g) => g.id === game.s);
        } else {
          guild = await new Promise(async (resolve) => {
            const g = await ShardManager.refreshGuild(game.s);
            resolve(g.find((g) => g.id === game.s));
          });
        }
      }

      if (!guild) {
        throw new Error(`Server (${game.s}) not found when saving game (${this._id})`);
      }

      const guildConfig = await GuildConfig.fetch(guild.id);

      if (guild && !channel) {
        const textChannels = guild.channels.filter((c) => c.type === "text");
        const channels = guildConfig.channels.filter((c) => guild.channels.find((gc) => gc.id == c.channelId)).map((c) => guild.channels.find((ch) => ch.id === c.channelId));
        if (channels.length === 0 && textChannels.length > 0) channels.push(textChannels[0]);
        channel = channels[0];
      }

      const lang = gmLanguages.find((l) => l.code === guildConfig.lang) || gmLanguages.find((l) => l.code === "en");
      const guildMembers = guild.members;

      if (!game.template) game.template = (guildConfig.gameTemplates.find((gt) => gt.isDefault) || guildConfig.gameTemplates[0]).id;
      const gameTemplate = guildConfig.gameTemplates.find((gt) => gt.id === game.template);

      moment.locale(lang.code);

      if (options.user && !game.dm.id && game.dm.tag === options.user.tag) game.dm.id = options.user.id;

      const authorParts = game.author.tag.replace("@", "").split("#");
      const dmParts = game.dm.tag.replace("@", "").split("#");
      let dm = dmParts[0];
      let dmmember =
        guildMembers.find((mem) => {
          return (
            mem.user.id === game.dm.id ||
            mem.user.tag === game.dm.tag.trim().replace("@", "") ||
            (dmParts[0] && dmParts[1] && mem.user.username === dmParts[0].trim() && mem.user.discriminator === dmParts[1].trim())
          );
        }) ||
        guildMembers.find((mem) => {
          return (
            mem.user.id === game.author.id ||
            mem.user.tag === game.author.tag.trim().replace("@", "") ||
            (authorParts[0] && authorParts[1] && mem.user.username === authorParts[0].trim() && mem.user.discriminator === authorParts[1].trim())
          );
        });
      if (dmmember) {
        var gmTag = dmmember.user.toString();
        if (guildConfig.embeds === false) dm = gmTag;
        else dm = dmmember.nickname || dm;
      } else if (!game._id && !options.force) {
        game.dm = game.author;
        dm = authorParts[0];
        dmmember = {
          id: game.author.id,
          nickname: null,
          roles: [],
          user: {
            id: game.author.id,
            tag: game.author.tag,
            username: (authorParts[0] || "").trim(),
            discriminator: (authorParts[1] || "").trim(),
            avatar: "",
            avatarUrl: "",
          },
          send: (content, options) => {},
          hasPermission: (permission: number) => {
            return false;
          },
        };
      }

      const rsvps = await GameRSVP.fetch(game._id);
      game.reserved = game.reserved.map((r) => {
        r.tag = r.tag.trim().replace(/^@/g, "");
        return r;
      });
      game.reserved = game._id ? rsvps.map((r) => r.data).sort((a, b) => (a.timestamp > b.timestamp ? 1 : -1)) : game.reserved.filter((r) => r.tag);
      const checkDupes = game.reserved.filter((r, i) => {
        const test = !/#\d{4}$/.test(r.tag.trim()) || game.reserved.findIndex((rr) => (rr.id ? rr.id === r.id : false) || (rr.tag === r.tag && /#\d{4}/i.test(r.tag))) === i;
        // console.log(r, test);
        return test;
      });
      // console.log(checkDupes, game.reserved.length, checkDupes.length);
      if (game.reserved.length > checkDupes.length) {
        game.reserved = checkDupes;
        rsvps.forEach((r, i) => {
          if (!/#\d{4}$/.test(r.tag.trim()) || game.reserved.findIndex((rr) => (rr.id ? rr.id === r.id : false) || (rr.tag === r.tag && /#\d{4}/i.test(r.tag))) < i) {
            r.delete();
          }
        });
      }

      let reserved: string[] = [];
      let waitlist: string[] = [];
      let rMentions: string[] = [];
      game.reserved.map((rsvp) => {
        delete rsvp._id;
        delete rsvp.timestamp;
        delete rsvp.gameId;

        if (rsvp.tag.trim().length === 0 && !rsvp.id) return;
        let member = guildMembers.find(
          (mem) => mem.user.tag.trim() === rsvp.tag.trim().replace("@", "") || mem.user.id == rsvp.tag.trim().replace(/[<@>]/g, "") || mem.user.id === rsvp.id
        );

        let name = rsvp.tag.trim().replace(/\#\d{4}/, "");
        if (member) {
          if (guildConfig.embeds === false || guildConfig.embedMentions) name = member.user.toString();
          else name = member.nickname || member.user.username;
          rsvp = {
            id: member.user.id,
            tag: member.user.tag,
          };
        }

        if (reserved.length < parseInt(game.players)) {
          reserved.push(reserved.length + 1 + ". " + name);
          if (member) rMentions.push(member.user.toString());
        } else {
          waitlist.push(reserved.length + waitlist.length + 1 + ". " + name);
        }

        return rsvp;
      });

      game.duration = Game.runtimeToHours(this.runtime);
      const eventTimes = aux.parseEventTimes(game, {
        isField: true,
      });
      const rawDate = eventTimes.rawDate;
      const timezone = "UTC" + (game.timezone >= 0 ? "+" : "") + game.timezone;
      const where = Game.parseDiscord(game.where, guild).trim();
      let description = Game.parseDiscord(game.description, guild).trim();

      let signups = "";
      let automatedInstructions = `\n(${guildConfig.emojiAdd} ${lang.buttons.SIGN_UP}${guildConfig.dropOut ? ` | ${guildConfig.emojiRemove} ${lang.buttons.DROP_OUT}` : ""})`;
      if (game.method === GameMethod.AUTOMATED) {
        if (reserved.length > 0) signups += `\n**${lang.game.RESERVED}:**\n${reserved.join("\n")}\n`;
        if (waitlist.length > 0 && !game.disableWaitlist) signups += `\n**${lang.game.WAITLISTED}:**\n${waitlist.join("\n")}\n`;
        signups += automatedInstructions;
      } else if (game.method === GameMethod.CUSTOM) {
        signups += `\n${game.customSignup}`;
      }

      let when = "",
        gameDate;
      if (game.when === GameWhen.DATETIME) {
        const date = Game.ISOGameDate(game);
        const tz = Math.round(parseFloat(game.timezone.toString()) * 4) / 4;
        if (game.tz) when = moment(date).tz(game.tz).format(config.formats.dateLongTZ) + ` (${timezone})`;
        else when = moment(date).utcOffset(tz).format(config.formats.dateLong) + ` (${timezone})`;
        gameDate = new Date(rawDate);
      } else if (game.when === GameWhen.NOW) {
        when = lang.game.options.NOW;
        gameDate = new Date();
      }

      game.timestamp = gameDate.getTime();
      game.xWeeks = Math.max(1, parseInt(`${game.xWeeks}`));

      let msg =
        `\n**${lang.game.GM}:** ${dm}` +
        `\n**${lang.game.GAME_NAME}:** ${game.adventure}` +
        `\n**${lang.game.RUN_TIME}:** ${game.runtime} ${lang.game.labels.HOURS}` +
        `\n**${lang.game.WHEN}:** ${game.hideDate ? lang.game.labels.TBD : when}` +
        `\n**${lang.game.WHERE}:** ${where}` +
        `${description.length > 0 ? `\n**${lang.game.DESCRIPTION}:**\n${description}\n` : description}` +
        `\n${signups}`;

      if (game.gameImage.trim().length > 2048) {
        game.gameImage = "";
      }

      let embed: MessageEmbed;
      if (guildConfig.embeds === false) {
        if (game && game.gameImage && game.gameImage.trim().length > 0) {
          embed = new discord.MessageEmbed();
          embed.setColor(gameTemplate && gameTemplate.embedColor ? gameTemplate.embedColor : guildConfig.embedColor);
          embed.setImage(game.gameImage.trim().substr(0, 2048));
        }
      } else {
        const urlRegex = /^((([A-Za-z]{3,9}:(?:\/\/)?)(?:[\-;:&=\+\$,\w]+@)?[A-Za-z0-9\.\-]+|(?:www\.|[\-;:&=\+\$,\w]+@)[A-Za-z0-9\.\-]+)((?:\/[\+~%\/\.\w\-_]*)?\??(?:[\-\+=&;%@\.\w_:\(\)]*)#?(?:[\.\!\/\\\w]*))?)$/gi;

        msg = "";
        embed = new discord.MessageEmbed();
        embed.setColor(gameTemplate && gameTemplate.embedColor ? gameTemplate.embedColor : guildConfig.embedColor);
        embed.setTitle(game.adventure);
        embed.setAuthor(dm, dmmember && dmmember.user.avatarUrl && dmmember.user.avatarUrl.match(urlRegex) ? dmmember.user.avatarUrl.substr(0, 2048) : null);
        if (dmmember && dmmember.user.avatarUrl && dmmember.user.avatarUrl.match(urlRegex)) embed.setThumbnail(dmmember.user.avatarUrl.substr(0, 2048));
        if (description.length > 0) embed.setDescription(description);
        if (game.hideDate) embed.addField(lang.game.WHEN, lang.game.labels.TBD, true);
        else embed.addField(lang.game.WHEN, when, true);
        if (game.runtime && game.runtime.trim().length > 0 && game.runtime.trim() != "0") embed.addField(lang.game.RUN_TIME, `${game.runtime} ${lang.game.labels.HOURS}`, guildConfig.embedMentions || where.trim().length > 0);
        if (guildConfig.embedMentions) embed.addField(lang.game.GM, gmTag, where.trim().length > 0);
        if (where.trim().length > 0) embed.addField(lang.game.WHERE, where);
        if (game.method === GameMethod.CUSTOM) {
          embed.addField(lang.game.CUSTOM_SIGNUP_INSTRUCTIONS, game.customSignup);
        }
        if (game.method === GameMethod.AUTOMATED || (game.method === GameMethod.CUSTOM && reserved.length > 0)) {
          const reservedHeader = `${lang.game.RESERVED} (${reserved.length}/${game.players})`;
          const waitlistHeader = `${lang.game.WAITLISTED} (${waitlist.length})`;
          let reservedColumn = [];
          if (reserved.length > 0) {
            reserved.forEach(r => {
              reservedColumn.push(r);
              if (reservedColumn.join("\n").length > 900) {
                embed.addField(reservedHeader, reservedColumn.join("\n"), true);
                reservedColumn = [];
              }
            });
            if (reservedColumn.length > 0) embed.addField(reservedHeader, reservedColumn.join("\n"), true);
            if (waitlist.length > 0 && !game.disableWaitlist) {
              reservedColumn = [];
              waitlist.forEach(w => {
                reservedColumn.push(w);
                if (reservedColumn.join("\n").length > 900) {
                  embed.addField(waitlistHeader, reservedColumn.join("\n"), true);
                  reservedColumn = [];
                }
              });
              if (reservedColumn.length > 0) embed.addField(waitlistHeader, reservedColumn.join("\n"), true);
            }
          }
          else {
            embed.addField(reservedHeader, lang.game.NO_PLAYERS, true);
          }
        }
        if (!game.hideDate)
          embed.addField(
            "Links",
            `[📅 ${lang.game.ADD_TO_CALENDAR}](${eventTimes.googleCal})\n[🗺 ${lang.game.CONVERT_TIME_ZONE}](${eventTimes.convert.timeAndDate})\n[⏰ ${lang.game.COUNTDOWN}](${eventTimes.countdown})`,
            true
          );
        if (game.method === GameMethod.AUTOMATED) embed.setFooter(automatedInstructions);
        if (game.gameImage && game.gameImage.trim().length > 0 && game.gameImage.trim().match(urlRegex)) embed.setImage(game.gameImage.trim().substr(0, 2048));
        if (game.thumbnail && game.thumbnail.trim().length > 0 && game.thumbnail.trim().match(urlRegex)) embed.setThumbnail(game.thumbnail.trim().substr(0, 2048));
        if (!this.hideDate) embed.setTimestamp(gameDate);
      }

      const dbCollection = connection().collection(collection);
      if (game._id) {
        game.sequence++;
        if (options.repost) {
          game.deleted = false;
          game.pruned = false;
        }

        const gameData = cloneDeep(game);
        const prev = await Game.fetch(game._id, this.client, [this._guild], false);
        delete gameData._id;

        gameData.updatedTimestamp = new Date().getTime();
        const updated = await dbCollection.updateOne({ _id: new ObjectId(game._id) }, { $set: gameData });
        let message: Message;
        try {
          try {
            if (game.messageId) message = await ShardManager.findMessage(this.client, guild.id, channel.id, game.messageId, dmmember, game.timestamp);
            // console.log(guild.id, channel.id, game.messageId, !!dmmember, game.timestamp, !!message);
          } catch (err) {}

          if (guildConfig.embeds) {
            if (guildConfig.embedMentionsAbove) {
              const mentions = [dmmember && dmmember.user.toString(), Game.parseDiscord(game.description, guild, true), rMentions.join(" ")].join(" ").trim().split(" ");
              msg = mentions.filter((m, i) => m && mentions.indexOf(m) === i).join(" ");
            }
          } else embed = null;

          if (channel && options.repost) {
            message = <Message>await channel.send(msg, embed);
            if (message) {
              await dbCollection.updateOne({ _id: new ObjectId(game._id) }, { $set: { messageId: message.id } });
              game.messageId = message.id;
            }
          }

          if (message) {
            if ((message.author ? message.author.id : (<any>message).authorID) === process.env.CLIENT_ID) {
              if (this.client) message = await ShardManager.clientMessageEdit(this.client, guild.id, channel.id, message.id, msg, embed);
              else message = await ShardManager.shardMessageEdit(guild.id, channel.id, message.id, msg, embed);
            }
          } 
          else return;

          this.addReactions(message, guildConfig);

          prev._id = prev._id.toString();
          game._id = game._id.toString();

          if (message) this.dmNextWaitlist(prev.reserved, game.reserved);

          const updatedGame: any = aux.objectChanges(prev, game);
          delete updatedGame.sequence;
          delete updatedGame.updatedTimestamp;
          if (Object.keys(updatedGame).length > 0) {
            if (this.client) {
              this.client.shard.send({
                type: "socket",
                name: "game",
                room: `g-${game.s}`,
                data: { action: "updated", gameId: game._id, game: updatedGame, guildId: game.s },
              });
            }
            else {
              io().to(`g-${game.s}`).emit("game", { action: "updated", gameId: game._id, game: updatedGame, guildId: game.s });
            }
          }
        } catch (err) {
          aux.log("UpdateGameError:", err);
          if (updated) updated.modifiedCount = 0;
        }

        const saved: GameSaveData = {
          _id: game._id,
          message: <Message>message,
          modified: updated && updated.modifiedCount > 0,
        };
        return saved;
      } else {
        game.createdTimestamp = new Date().getTime();
        game.updatedTimestamp = new Date().getTime();
        const inserted = await dbCollection.insertOne(game);
        let message: Message;

        try {
          if (inserted.insertedCount > 0) {
            const updatedGame = new Game(game, this.guilds, this.client);
            for (let i = 0; i < updatedGame.reserved.length; i++) {
              const ru = updatedGame.reserved[i];
              let member = guildMembers.find(
                (mem) => mem.user.tag.trim() === ru.tag.trim().replace("@", "") || mem.user.id == ru.tag.trim().replace(/[<@>]/g, "") || mem.user.id === ru.id
              );
              const rsvp = new GameRSVP({ _id: new ObjectID(), gameId: inserted.insertedId, id: ru.id, tag: ru.tag, timestamp: game.createdTimestamp + i });
              await rsvp.save();
              if (member) {
                this.dmCustomInstructions(member.user);
              }
            }
          }

          if (guildConfig.embeds) {
            if (guildConfig.embedMentionsAbove) {
              const mentions = [dmmember && dmmember.user.toString(), Game.parseDiscord(game.description, guild, true), rMentions.join(" ")].join(" ").trim().split(" ");
              msg = mentions.filter((m, i) => m && mentions.indexOf(m) === i).join(" ");
            }
          } else embed = null;

          message = <Message>await channel.send(msg, embed);

          this.addReactions(message, guildConfig);
        } catch (err) {
          aux.log("InsertGameError:", "game.s", game.s, "game._id", game._id, err.message);
          if (inserted.insertedCount > 0) {
            await Game.hardDelete(inserted.insertedId);
            inserted.insertedCount = 0;
          }

          return {
            _id: "",
            message: null,
            modified: false,
          };
        }

        let updated;
        if (message) {
          updated = await dbCollection.updateOne({ _id: new ObjectId(inserted.insertedId) }, { $set: { messageId: message.id } });
          if (dmmember) {
            try {
              const dmEmbed = new MessageEmbed();
              dmEmbed.setColor(gameTemplate && gameTemplate.embedColor ? gameTemplate.embedColor : guildConfig.embedColor);
              dmEmbed.setTitle(lang.buttons.EDIT_GAME);
              dmEmbed.setURL(host + config.urls.game.create.path + "?g=" + inserted.insertedId);
              dmEmbed.addField(lang.game.SERVER, guild.name, true);
              dmEmbed.addField(lang.game.GAME_NAME, `[${game.adventure}](https://discordapp.com/channels/${this.discordGuild.id}/${this.discordChannel.id}/${message.id})`, true);
              const pm = await dmmember.send(dmEmbed);
              if (pm) await dbCollection.updateOne({ _id: new ObjectId(inserted.insertedId) }, { $set: { pm: pm.id } });
            } catch (err) {
              aux.log("EditLinkError:", err);
            }
          }
        } else {
          if (inserted.insertedCount > 0) {
            aux.log(`GameMessageNotPostedError:\n`, "s", game.s, "_id", game._id);
            await Game.hardDelete(inserted.insertedId);
          }

          if (dmmember) {
            dmmember.send("The bot does not have sufficient permissions to post in the configured Discord channel");
          }

          return {
            _id: "",
            message: null,
            modified: false,
          };
        }

        if (this.client)
          this.client.shard.send({
            type: "socket",
            name: "game",
            room: `g-${game.s}`,
            data: { action: "new", gameId: inserted.insertedId.toString(), guildId: game.s, authorId: game.author.id },
          });
        else {
          io().to(`g-${game.s}`).emit("game", { action: "new", gameId: inserted.insertedId.toString(), guildId: game.s, authorId: game.author.id });
        }

        const saved: GameSaveData = {
          _id: inserted.insertedId.toString(),
          message: message,
          modified: updated && updated.modifiedCount > 0,
        };
        return saved;
      }
    } catch (err) {
      aux.log("GameSaveError", game._id, err);

      if (game._id && options.force) {
        const dbCollection = connection().collection(collection);
        const result = await dbCollection.updateOne({ _id: new ObjectId(game._id) }, { $set: game });

        return {
          _id: "",
          message: null,
          modified: result.modifiedCount > 0,
        };
      }

      return {
        _id: "",
        message: null,
        modified: false,
      };
    }
  }

  static async fetch(gameId: string | number | ObjectID, client?: Client, sGuilds?: ShardGuild[], updateResList: boolean = true): Promise<Game> {
    if (!connection()) {
      aux.log("No database connection");
      return null;
    }
    const game = await connection()
      .collection(collection)
      .findOne({ _id: new ObjectId(gameId) });
    if (!game) return null;
    const guilds = sGuilds ? sGuilds : game.s ? (client ? await ShardManager.clientGuilds(client, [game.s]) : await ShardManager.shardGuilds({ guildIds: [game.s] })) : [];
    const sGame = new Game(game, guilds, client);
    if (sGame) {
      if (updateResList) await sGame.updateReservedList();
      return sGame;
    } else return null;
  }

  static async fetchBy(key: string, value: any, client?: Client): Promise<Game> {
    try {
      if (!connection()) {
        aux.log("No database connection");
        return null;
      }
      const query: mongodb.FilterQuery<any> = aux.fromEntries([[key, value]]);
      const game: GameModel = await connection()
        .collection(collection)
        .findOne({ deleted: { $in: [null, false] }, ...query });
      if (!game) return null;
      const guilds = client ? await ShardManager.clientGuilds(client, [game.s]) : await ShardManager.shardGuilds({ guildIds: [game.s] });
      const sGame = new Game(game, guilds, client);
      if (sGame) {
        await sGame.updateReservedList();
        return sGame;
      } else return null;
    } catch (err) {
      aux.log("Game.fetchBy Error:", err);
      return null;
    }
  }

  static async fetchAllBy(query: mongodb.FilterQuery<any>, client?: Client, sGuilds?: ShardGuild[], includeDeleted: boolean = false): Promise<Game[]> {
    if (!connection()) {
      aux.log("No database connection");
      return [];
    }
    const games: GameModel[] = await connection()
      .collection(collection)
      .find({ ...(includeDeleted ? null : { deleted: { $in: [null, false] } }), ...query })
      .toArray();
    const out: Game[] = [];
    for (let i = 0; i < games.length; i++) {
      const guilds = sGuilds ? sGuilds : client ? await ShardManager.clientGuilds(client, [games[i].s]) : await ShardManager.shardGuilds({ guildIds: [games[i].s] });
      const game = new Game(games[i], guilds, client);
      await game.updateReservedList();
      out.push(game);
    }
    return out;
  }

  static async fetchAllByLimit(query: mongodb.FilterQuery<any>, limit: number, client?: Client, sGuilds?: ShardGuild[]): Promise<Game[]> {
    if (!connection()) {
      aux.log("No database connection");
      return [];
    }
    const games: GameModel[] = await connection()
      .collection(collection)
      .find({ deleted: { $in: [null, false] }, ...query })
      .limit(limit)
      .toArray();
    const out: Game[] = [];
    for (let i = 0; i < games.length; i++) {
      const guilds = sGuilds ? sGuilds : client ? await ShardManager.clientGuilds(client, [games[i].s]) : await ShardManager.shardGuilds({ guildIds: [games[i].s] });
      let game = new Game(games[i], guilds, client);
      await game.updateReservedList();
      out.push(game);
    }
    return out;
  }

  static async updateAllBy(query: mongodb.FilterQuery<any>, update: any) {
    if (!connection()) {
      aux.log("No database connection");
      return [];
    }
    return await connection().collection(collection).updateMany(query, update, {
      upsert: false,
    });
  }

  async addReactions(message: Message, guildConfig: GuildConfig) {
    try {
      let gcChanged = false;
      const game = cloneDeep(this.data);
      const guild = this.discordGuild;
      const channel = this.discordChannel;

      if (message) {
        try {
          if (game.method === GameMethod.AUTOMATED) {
            if (this.client) message.react(guildConfig.emojiAdd);
            else await ShardManager.shardMessageReact(guild.id, channel.id, message.id, guildConfig.emojiAdd);
          }
        } catch (err) {
          if (!aux.isEmoji(guildConfig.emojiAdd)) {
            guildConfig.emojiAdd = "➕";
            gcChanged = true;
            if (game.method === GameMethod.AUTOMATED) {
              if (this.client) message.react(guildConfig.emojiAdd);
              else await ShardManager.shardMessageReact(guild.id, channel.id, message.id, guildConfig.emojiAdd);
            }
          }
        }
        if (guildConfig.dropOut) {
          try {
            if (game.method === GameMethod.AUTOMATED) {
              if (this.client) message.react(guildConfig.emojiRemove);
              else await ShardManager.shardMessageReact(guild.id, channel.id, message.id, guildConfig.emojiRemove);
            }
          } catch (err) {
            if (!aux.isEmoji(guildConfig.emojiRemove)) {
              guildConfig.emojiRemove = "➖";
              gcChanged = true;
              if (game.method === GameMethod.AUTOMATED) {
                if (this.client) message.react(guildConfig.emojiRemove);
                else await ShardManager.shardMessageReact(guild.id, channel.id, message.id, guildConfig.emojiRemove);
              }
            }
          }
        }
      }

      if (gcChanged) {
        guildConfig.save(guildConfig.data);
        guildConfig.updateReactions(this.client);
      }
    } catch (err) {
      aux.log(err);
      if (this.discordChannel) this.discordChannel.send("The bot does not have sufficient permissions to add reactions in this channel.");
    }
  }

  static getNextDate(baseDate: moment.Moment, validDays: string[], frequency: Frequency, monthlyType: MonthlyType, xWeeks: number = 2) {
    if (frequency == Frequency.NO_REPEAT) return null;

    let dateGenerator;
    let nextDate = baseDate;

    try {
      switch (frequency) {
        case Frequency.DAILY:
          nextDate = moment(baseDate).add(1, "days");
          break;
        case Frequency.WEEKLY: // weekly
          if (validDays === undefined || validDays.length === 0) break;
          dateGenerator = moment(baseDate).recur().every(validDays).daysOfWeek();
          nextDate = dateGenerator.next(1)[0];
          break;
        case Frequency.BIWEEKLY: // biweekly
          if (validDays === undefined || validDays.length === 0) break;
          // this is a compound interval...
          dateGenerator = moment(baseDate).recur().every(validDays).daysOfWeek();
          nextDate = dateGenerator.next(1)[0];
          while (nextDate.week() - moment(baseDate).week() < xWeeks) {
            // if the next date is in the same week, diff = 0. if it is just next week, diff = 1, so keep going forward.
            dateGenerator = moment(nextDate).recur().every(validDays).daysOfWeek();
            nextDate = dateGenerator.next(1)[0];
          }
          break;
        case Frequency.MONTHLY:
          if (monthlyType == MonthlyType.WEEKDAY) {
            const weekOfMonth = moment(baseDate).monthWeekByDay();
            const validDay = moment(baseDate).day();
            dateGenerator = moment(baseDate).recur().every(validDay).daysOfWeek().every(weekOfMonth).weeksOfMonthByDay();
            nextDate = dateGenerator.next(1)[0];

            if (weekOfMonth == 4 && moment(nextDate).month() != moment(baseDate).month() + 1) {
              dateGenerator = moment(baseDate).recur().every(validDay).daysOfWeek().every(3).weeksOfMonthByDay();
              nextDate = dateGenerator.next(1)[0];
            }
          } else {
            nextDate = moment(baseDate).add(1, "month");
          }
          break;
        default:
          throw new Error(`invalid frequency ${frequency} specified`);
      }
    } catch (err) {
      aux.log(err.message || err);
      return null;
    }

    return moment(nextDate).format("YYYY-MM-DD");
  }

  public getWeekdays() {
    const days = this.weekdays;
    const validDays = [];
    for (let i = 0; i < days.length; i++) {
      if (days[i] == true) {
        validDays.push(moment.weekdays(false, i));
      }
    }
    return validDays;
  }

  static runtimeToHours(runtime: string | number) {
    let hours = 0,
      x: RegExpExecArray;
    if ((x = /[\d\.]+/g.exec(runtime.toString().trim()))) {
      if (x[0]) hours = parseFloat(x[0]);
    }
    return hours;
  }

  public canReschedule() {
    const validDays = this.getWeekdays();
    const hours = this.duration !== null ? this.duration : Game.runtimeToHours(this.runtime);
    const gameEnded = this.timestamp + hours * 3600 * 1000 < new Date().getTime();
    const nextDate = Game.getNextDate(moment(this.date), validDays, Number(this.frequency), this.monthlyType, this.xWeeks);
    if (!nextDate) return false;
    const nextISO = `${nextDate.replace(/-/g, "")}T${this.time.replace(/:/g, "")}00${this.timezone >= 0 ? "+" : "-"}${aux.parseTimeZoneISO(this.timezone)}`;
    const nextGamePassed = new Date(nextISO).getTime() <= new Date().getTime();
    return (
      gameEnded &&
      !this.rescheduled &&
      !nextGamePassed &&
      this.when == GameWhen.DATETIME &&
      (this.frequency == Frequency.DAILY ||
        this.frequency == Frequency.MONTHLY ||
        ((this.frequency == Frequency.WEEKLY || this.frequency == Frequency.BIWEEKLY) && validDays.length > 0))
    );
  }

  async reschedule() {
    try {
      const validDays = this.getWeekdays();
      const nextDate = Game.getNextDate(moment(this.date), validDays, Number(this.frequency), this.monthlyType, this.xWeeks);
      this.date = nextDate;

      const guildConfig = await GuildConfig.fetch(this.s);

      if (this.client && this.dm.id) {
        const guild = this.client.guilds.cache.find(g => g.id === this.s);
        if (guild) {
          const member = guild.members.cache.find(m => m.user.id === this.dm.id);
          if (!member || !guildConfig.memberHasPermission(member, this.c)) {
            aux.log(`Removing game ${this._id} from ${this.s}. User no longer has permission to post games.`);
            this.frequency = Frequency.NO_REPEAT;
            await this.save();
            await this.delete();
            return false;
          }
        }
      }

      aux.log(`Rescheduling ${this.s}: ${this.adventure} from ${this.date} (${this.time}) to ${nextDate} (${this.time})`);
      if (guildConfig.rescheduleMode === RescheduleMode.UPDATE) {
        if (this.clearReservedOnRepeat) {
          this.reserved = [];
          await GameRSVP.deleteGame(this._id);
        }
        this.reminded = null;
        this.reminderMessageId = null;
        this.pm = null;
        await this.save();
      } else if (guildConfig.rescheduleMode === RescheduleMode.REPOST) {
        let data = cloneDeep(this.data);
        let guilds;
        if (this.client) {
          guilds = await ShardManager.clientGuilds(this.client, [data.s]);
        } else {
          guilds = await ShardManager.shardGuilds({ guildIds: [data.s] });
        }
        const id = data._id;
        if (this.clearReservedOnRepeat) {
          data.reserved = [];
        }
        delete data._id;
        delete data.reminded;
        delete data.pm;
        delete data.messageId;
        delete data.reminderMessageId;
        delete data.sequence;
        const game = new Game(data, guilds, this.client);
        try {
          const newGame = await game.save();
          if (newGame.message && newGame.modified) {
            if (this.client)
              this.client.shard.send({
                type: "socket",
                name: "game",
                room: `g-${game.s}`,
                data: { action: "rescheduled", gameId: this._id, newGameId: newGame._id },
              });
            else {
              io().to(`g-${game.s}`).emit("game", { action: "rescheduled", gameId: this._id, newGameId: newGame._id });
            }

            const del = await this.delete();
            if (del.modifiedCount == 0) {
              const del2 = await Game.softDelete(id);
              if (del2.modifiedCount == 0) {
                this.rescheduled = true;
                await this.save();
              }
            }
            return true;
          } else {
            await game.delete();
            return false;
          }
        } catch (err) {
          aux.log(err);
          await game.delete();
          return false;
        }
      }
    } catch (err) {
      aux.log("GameRescheduleError:", err.message || err);
      return false;
    }
  }

  static async softDeleteAllBy(query: mongodb.FilterQuery<any>) {
    if (!connection()) {
      aux.log("No database connection");
      return null;
    }
    return await connection()
      .collection(collection)
      .updateMany({ ...query }, { $set: { deleted: true, frequency: Frequency.NO_REPEAT } });
  }

  static async hardDeleteAllBy(query: mongodb.FilterQuery<any>) {
    if (!connection()) {
      aux.log("No database connection");
      return { deletedCount: 0 };
    }
    return await connection()
      .collection(collection)
      .deleteMany({ ...query });
  }

  static async deleteAllBy(query: mongodb.FilterQuery<any>, client?: Client, sGuilds?: ShardGuild[]) {
    if (!connection()) {
      aux.log("No database connection");
      return { deletedCount: 0 };
    }
    let deleteQuery = { ...query, ...{ deleted: { $in: [null, false, true] } } };
    let games = await Game.fetchAllByLimit(deleteQuery, 200, client, sGuilds);
    let deletedCount = 0;
    while (games.length > 0 && deletedCount < 2000) {
      const gameIds = games.map((g) => g._id);
      await GameRSVP.deleteAllGames(gameIds);
      const result = await Game.hardDeleteAllBy({ _id: { $in: gameIds.map((gid) => new ObjectID(gid)) } });
      deletedCount += result.deletedCount;
      games = await Game.fetchAllByLimit(deleteQuery, 200, client, sGuilds);
    }
    return { deletedCount: deletedCount };
  }

  static async hardDelete(_id: string | number | mongodb.ObjectID) {
    await GameRSVP.deleteGame(_id);
    return await connection()
      .collection(collection)
      .deleteOne({ _id: new ObjectId(_id) });
  }

  static async softDelete(_id: string | number | mongodb.ObjectID) {
    return await connection()
      .collection(collection)
      .updateOne({ _id: new ObjectId(_id) }, { $set: { deleted: true, frequency: Frequency.NO_REPEAT } });
  }

  async undelete() {
    return await this.save({
      repost: true
    });
  }

  async delete(options: any = {}) {
    if (!connection()) {
      aux.log("No database connection");
      return { modifiedCount: 0 };
    }

    try {
      var result = await Game.softDelete(this._id);
    } catch (err) {
      aux.log(err.message || err);
    }

    const { sendWS = true } = options;
    const game: GameModel = this;
    const channel = this._channel;

    if (channel) {
      try {
        if (game.messageId) {
          const message = await channel.messages.fetch(game.messageId);
          if (message) {
            message.delete().catch((err) => {
              aux.log("Attempted to delete announcement message.");
              // aux.log(err);
            });
          }
        }
      } catch (e) {
        // aux.log("Announcement:", e.message);
      }

      try {
        if (game.reminderMessageId) {
          const message = await channel.messages.fetch(game.reminderMessageId);
          if (message) {
            message.delete().catch((err) => {
              aux.log("Attempted to delete reminder message.");
              // aux.log(err);
            });
          }
        }
      } catch (e) {
        aux.log("Reminder:", e.message);
      }

      // try {
      //   if (game.pm) {
      //     const guild = this._guild;
      //     const dm = guild.members.find(m => m.user.tag === game.dm.tag || m.user.id === game.dm.id);
      //     if (dm && dm.user.dmChannel) {
      //       await dm.user.dmChannel.delete(game.pm);
      //     }
      //   }
      // } catch (e) {
      //   aux.log("DM:", e.message);
      // }
    }

    if (sendWS) {
      if (this.client)
        this.client.shard.send({
          type: "socket",
          name: "game",
          room: `g-${game.s}`,
          data: { action: "deleted", gameId: game._id, guildId: game.s },
        });
      else {
        io().to(`g-${game.s}`).emit("game", { action: "deleted", gameId: game._id, guildId: game.s });
      }
    }
    return result;
  }

  async dmCustomInstructions(user: User | ShardUser) {
    if (this.method === "automated" && this.customSignup.trim().length > 0 && this.discordGuild) {
      const guild = this.discordGuild;
      const guildMembers = await guild.members;
      const guildConfig = await GuildConfig.fetch(guild.id);
      const dmmember = guildMembers.find((m) => m.user.tag === this.dm.tag.trim() || m.user.id === this.dm.id);
      const member = guildMembers.find((m) => m.user.tag === user.tag.trim() || m.user.id === user.id);
      if (!this.template) this.template = (guildConfig.gameTemplates.find((gt) => gt.isDefault) || guildConfig.gameTemplates[0]).id;
      const gameTemplate = guildConfig.gameTemplates.find((gt) => gt.id === this.template);

      if (member) {
        const lang = gmLanguages.find((l) => l.code === guildConfig.lang) || gmLanguages.find((l) => l.code === "en");

        let waitlisted = "";
        if (this.reserved.findIndex((r) => r.id === member.user.id || r.tag === member.user.tag) + 1 > parseInt(this.players)) {
          const slotNum = this.reserved.findIndex((r) => r.id === member.user.id || r.tag === member.user.tag) + 1 - parseInt(this.players);
          waitlisted = `\n\n${lang.other.DM_WAITLIST.replace(":NUM", slotNum)}`;
        }

        const dmEmbed = new MessageEmbed();
        dmEmbed.setDescription(
          `**[${this.adventure}](https://discordapp.com/channels/${this.discordGuild.id}/${this.discordChannel.id}/${this.messageId})**\n${Game.parseDiscord(
            this.customSignup,
            this.discordGuild
          )}${waitlisted}`
        );
        dmEmbed.setColor(gameTemplate && gameTemplate.embedColor ? gameTemplate.embedColor : guildConfig.embedColor);

        member.send(`${lang.other.DM_INSTRUCTIONS.replace(":DM", dmmember ? dmmember.user.toString() : this.dm.tag).replace(" :EVENT", ``)}:`, {
          embed: dmEmbed,
        });
      }
    }
  }

  async dmNextWaitlist(pReserved, gReserved) {
    if (pReserved.length <= gReserved.length) return;
    if (gReserved.length < parseInt(this.players)) return;
    const pMaxPlayer = (pReserved[parseInt(this.players) - 1] || { tag: "" }).tag;
    const gMaxPlayer = (gReserved[parseInt(this.players) - 1] || { tag: "" }).tag;
    if (pMaxPlayer.trim() == gMaxPlayer.trim()) return;
    const guildMembers = this.discordGuild.members;
    const guildConfig = await GuildConfig.fetch(this.discordGuild.id);
    const lang = gmLanguages.find((l) => l.code === guildConfig.lang) || gmLanguages.find((l) => l.code === "en");
    if (!this.template) this.template = (guildConfig.gameTemplates.find((gt) => gt.isDefault) || guildConfig.gameTemplates[0]).id;
    const gameTemplate = guildConfig.gameTemplates.find((gt) => gt.id === this.template);

    this.reserved.forEach((res, index) => {
      var member = guildMembers.find((mem) => mem.user.tag.trim() === res.tag.trim() || mem.user.id === res.id);

      if (index + 1 === parseInt(this.players) && lang.other) {
        const embed = new MessageEmbed();

        embed.setColor(gameTemplate && gameTemplate.embedColor ? gameTemplate.embedColor : guildConfig.embedColor);

        let message = lang.other.YOURE_IN;
        message = message.replace(
          ":GAME",
          this.messageId ? `[${this.adventure}](https://discordapp.com/channels/${this.discordGuild.id}/${this.discordChannel.id}/${this.messageId})` : this.adventure
        );
        message = message.replace(":SERVER", this.discordGuild.name);
        embed.setDescription(message);

        embed.addField(lang.game.WHERE, Game.parseDiscord(this.where, this.discordGuild));

        const eventTimes = aux.parseEventTimes(this.data);
        if (!this.hideDate) embed.setTimestamp(new Date(eventTimes.rawDate));

        if (member) member.send(embed);
      }
    });
  }

  static ISOGameDate(game: GameModel) {
    return `${game.date.replace(/-/g, "")}T${game.time.replace(/:/g, "")}00${game.timezone >= 0 ? "+" : "-"}${aux.parseTimeZoneISO(game.timezone)}`;
  }

  async updateReservedList() {
    let guildMembers: ShardMember[];
    try {
      const t = new Date().getTime() - 100 * this.reserved.length;
      if (!this.discordGuild) return;
      if (!guildMembers) guildMembers = this.discordGuild.members;
      this.reserved = this.reserved.map((r) => {
        r.tag = r.tag.trim().replace(/^@/g, "");
        return r;
      });
      const checkDupes = this.reserved.filter(
        (r, i) => !/#\d{4}$/.test(r.tag.trim()) || this.reserved.findIndex((rr) => (rr.id ? rr.id === r.id : false) || (rr.tag === r.tag && /#\d{4}/i.test(r.tag))) === i
      );
      if (this.reserved.length > checkDupes.length) {
        this.reserved = checkDupes;
      }
      const rsvps = await GameRSVP.fetch(this._id);
      for (let i = 0; i < this.reserved.length; i++) {
        try {
          const res = cloneDeep(this.reserved[i]);
          const member = guildMembers.find((m) => this.reserved[i] && m.user && (m.user.id === this.reserved[i].id || m.user.tag === this.reserved[i].tag.trim()));
          const countMatches = this.reserved.filter((rr, ri) => ri <= i && ((rr.id ? rr.id === res.id : false) || (rr.tag === res.tag && !/#\d{4}/i.test(res.tag))));
          const rsvpMatches = rsvps.filter((r) => r._id === res._id || (r.id && r.id === res.id) || r.tag === res.tag);
          // console.log(res.tag, countMatches.length, rsvpMatches.length);
          
          let rsvp = rsvps.find((r) => r._id === res._id || (r.id && r.id === res.id) || r.tag === res.tag);
          // if (rsvp && rsvp.id && !member) continue;
          if (!rsvp) rsvp = await GameRSVP.fetchRSVP(this._id, res.id || res.tag);
          if (!rsvp || (!/#\d{4}/i.test(res.tag) && countMatches.length > rsvpMatches.length)) {
            rsvp = new GameRSVP({
              _id: new ObjectID(res._id),
              gameId: this._id,
              id: member ? member.user.id : (rsvp && rsvp.id) || (res && res.id),
              tag: member ? member.user.tag : res.tag,
              timestamp: t + i * 100,
            });
            await rsvp.save();
            rsvps.push(rsvp);
          }
          if (rsvp) {
            this.reserved[i] = {
              id: rsvp.id,
              tag: rsvp.tag,
            };
          }
        } catch (err) {
          aux.log("InsertRSVPError:", err);
        }
      }
      this.reserved = this.reserved.filter(
        (r, i) => !/#\d{4}$/.test(r.tag.trim()) || this.reserved.findIndex((rr) => (rr.id ? rr.id === r.id : false) || (rr.tag === r.tag && /#\d{4}/i.test(r.tag))) === i
      );
      // console.log(this.reserved);
    } catch (err) {
      aux.log("UpdateReservedListError:", err);
    }
    return this.data;
  }

  static updateDM(dm: RSVP | string, guildMembers: ShardMember[]) {
    if (typeof dm === "string") {
      const rsvp: RSVP = { tag: dm.trim() };
      const member = guildMembers.find((m) => m.user.tag === dm.trim());
      if (member) {
        rsvp.id = member.user.id;
      }
      return rsvp;
    } else {
      return dm;
    }
  }

  async signUp(user: User | ShardUser, t?: number): Promise<{ result: boolean, message?: string }> {
    if (!this.discordGuild) return { result: false, message: "Server not found!" };

    const guildConfig = await GuildConfig.fetch(this.s);
    const member = this.discordGuild.members.find((m) => m.user.tag === user.tag.trim() || m.user.id === user.id);
    const lang = gmLanguages.find((l) => l.code === guildConfig.lang) || gmLanguages.find((l) => l.code === "en");

    const hourDiff = (new Date().getTime() - this.timestamp) / 1000 / 3600;
    if (hourDiff >= 0 && !this.pastSignups && !this.hideDate) {
      if (member) member.send(lang.other.ALREADY_STARTED);
      return { result: false, message: lang.other.ALREADY_STARTED };
    }

    if (this.disableWaitlist && this.reserved.length >= parseInt(this.players)) {
      if (member) member.send(lang.other.MAX_NO_WAITLIST);
      return { result: false, message: lang.other.MAX_NO_WAITLIST };
    }

    const template = guildConfig.gameTemplates.find(t => t.id.toString() === this.template) || guildConfig.gameTemplates.find(t => t.isDefault);
    if (template && template.playerRole && template.playerRole.length > 0) {
      if (!template.playerRole.find(pr => member.roles.find(r => r.id === pr.id || (!pr.id && r.name === pr.name)))) {
        const separator = "`, `"
        const pattern = new RegExp('(\\b' + separator + '\\b)(?!.*\\b\\1\\b)', 'i');
        let message = template.playerRole.map(pr => pr.name).join(separator);
        if (message.indexOf(separator) === message.lastIndexOf(separator)) message = message.replace(separator, "` "+lang.other.OR+" `");
        else message = message.replace(pattern, "`, "+lang.other.OR+" `");
        if (member) member.send(lang.other.MISSING_PLAYER_ROLE.replace(/\:ROLE/g, `\`${message}\``));
        return { result: false, message: lang.other.MISSING_PLAYER_ROLE.replace(/\:ROLE/g, `\`${message}\``) };
      }
    }

    let match = await GameRSVP.fetchRSVP(this._id, user.id);
    if (match && !this.reserved.find((r) => r.id === match.id || r.tag === match.tag)) {
      await GameRSVP.deleteUser(this._id, user.id);
      match = null;
    }
    if (!match) {
      const rsvp = new GameRSVP({ _id: new ObjectID(), gameId: this._id, id: user.id, tag: user.tag, timestamp: t || new Date().getTime() });
      await rsvp.save();
      await this.save();
      this.dmCustomInstructions(user);
      return { result: true };
    }
    return { result: false, message: "An error occurred!" };
  }

  async dropOut(user: User | ShardUser, guildConfig: GuildConfig): Promise<{ result: boolean, message?: string }> {
    const hourDiff = (new Date().getTime() - this.timestamp) / 1000 / 3600;
    if (guildConfig.dropOut) {
      if (hourDiff < 0 || this.pastSignups || this.hideDate) {
        const rsvps = await GameRSVP.fetch(this._id);
        const frsvp = rsvps.filter((r) => r.id == user.id || r.tag == user.tag);
        for (let i = 0; i < frsvp.length; i++) {
          const rsvp = frsvp[i];
          await rsvp.delete();
        }
        await this.save();
        await GameRSVP.deleteUser(this._id, user.id);
        await GameRSVP.deleteUser(this._id, user.tag);
        return { result: true };
      } else {
        if (!this.discordGuild) return { result: false, message: "Server not found!" };
        const member = this.discordGuild.members.find((m) => m.user.tag === user.tag.trim() || m.user.id === user.id);
        const guildConfig = await GuildConfig.fetch(this.s);
        const lang = gmLanguages.find((l) => l.code === guildConfig.lang) || gmLanguages.find((l) => l.code === "en");
        if (member) member.send(lang.other.ALREADY_STARTED);
        return { result: false, message: lang.other.ALREADY_STARTED }
      }
    }
    return { result: false, message: "Dropouts are not allowed" };
  }

  static parseDiscord(text: string, guild: ShardGuild, getMentions: boolean = false) {
    const mentions: string[] = [];
    try {
      guild.roles.forEach((role) => {
        // const canMention = guild.members.hasPermission(Permissions.FLAGS.toString()_EVERYONE);
        const canMention = true;
        if ((!role.mentionable && !canMention) || ["@everyone", "@here"].includes(role.name)) return;
        if (new RegExp(`<?\@&?(${aux.backslash(role.id)}|${aux.backslash(role.name)})>?`, "gi").test(text)) mentions.push(`<@&${role.id}>`);
        text = text.replace(new RegExp(`<?\@&?(${aux.backslash(role.id)}|${aux.backslash(role.name)})>?`, "gi"), `<@&${role.id}>`);
      });
      guild.members.forEach((mem) => {
        if (new RegExp(`<?\@(${aux.backslash(mem.user.id)}|${aux.backslash(mem.user.tag)})>?`, "gi").test(text)) mentions.push(mem.user.toString());
        text = text.replace(new RegExp(`<?\@(${aux.backslash(mem.user.id)}|${aux.backslash(mem.user.tag)})>?`, "gi"), mem.user.toString());
      });
      guild.channels.forEach((c) => {
        text = text.replace(new RegExp(`\#${aux.backslash(c.name)}`, "gi"), `<#${c.id}>`);
      });
    } catch (err) {
      aux.log(err);
    }
    if (getMentions) return mentions.join(" ");
    return text;
  }
}
