import { i18n } from '../localization';
import GUI, { TABS } from '../gui';
import { get as getConfig, set as setConfig } from '../ConfigStorage';
import { get as getStorage, set as setStorage } from '../SessionStorage';
import BuildApi from '../BuildApi';
import ConfigInserter from "../ConfigInserter.js";
import { tracking } from "../Analytics";
import MspHelper from '../msp/MSPHelper';
import STM32 from '../protocols/stm32';
import FC from '../fc';
import MSP from '../msp';
import MSPCodes from '../msp/MSPCodes';
import PortHandler, { usbDevices } from '../port_handler';
import CONFIGURATOR, { API_VERSION_1_39 } from '../data_storage';
import serial from '../serial';
import STM32DFU from '../protocols/stm32usbdfu';
import { gui_log } from '../gui_log';
import semver from 'semver';
import { checkChromeRuntimeError } from '../utils/common';

const firmware_flasher = {
    targets: null,
    releaseLoader: new BuildApi(),
    localFirmwareLoaded: false,
    selectedBoard: undefined,
    boardNeedsVerification: false,
    intel_hex: undefined, // standard intel hex in string format
    parsed_hex: undefined, // parsed raw hex in array format
    isConfigLocal: false, // Set to true if the user loads one locally
    configFilename: null,
    config: {},
    developmentFirmwareLoaded: false, // Is the firmware to be flashed from the development branch?
};

firmware_flasher.initialize = function (callback) {
    const self = this;

    if (GUI.active_tab !== 'firmware_flasher') {
        GUI.active_tab = 'firmware_flasher';
    }

    self.selectedBoard = undefined;
    self.localFirmwareLoaded = false;
    self.isConfigLocal = false;
    self.intel_hex = undefined;
    self.parsed_hex = undefined;

    function onDocumentLoad() {

        function parseHex(str, callback) {
            // parsing hex in different thread
            const worker = new Worker('./js/workers/hex_parser.js');

            // "callback"
            worker.onmessage = function (event) {
                callback(event.data);
            };

            // send data/string over for processing
            worker.postMessage(str);
        }

        function showLoadedHex(fileName) {
            if (self.localFirmwareLoaded) {
                self.flashingMessage(i18n.getMessage('firmwareFlasherFirmwareLocalLoaded', { filename: fileName, bytes: self.parsed_hex.bytes_total }), self.FLASH_MESSAGE_TYPES.NEUTRAL);
            } else {
                self.flashingMessage(`<a class="save_firmware" href="#" title="Save Firmware">${i18n.getMessage('firmwareFlasherFirmwareOnlineLoaded', { filename: fileName, bytes: self.parsed_hex.bytes_total })}</a>`,
                    self.FLASH_MESSAGE_TYPES.NEUTRAL);
            }
            self.enableFlashing(true);
        }

        function showReleaseNotes(summary) {
            if (summary.manufacturer) {
                $('div.release_info #manufacturer').text(summary.manufacturer);
                $('div.release_info #manufacturerInfo').show();
            } else {
                $('div.release_info #manufacturerInfo').hide();
            }

            $('div.release_info .target').text(summary.target);
            $('div.release_info .name').text(summary.release).prop('href', summary.releaseUrl);
            $('div.release_info .date').text(summary.date);
            $('div.release_info #targetMCU').text(summary.mcu);
            $('div.release_info .configFilename').text(self.isConfigLocal ? self.configFilename : "[default]");

            // Wiki link to url found in unified target configuration or if not defined to general wiki url
            const targetWiki = $('#targetWikiInfoUrl');
            targetWiki.html(`&nbsp;&nbsp;&nbsp;[Wiki]`);
            targetWiki.attr("href", summary.wiki === undefined ? "https://betaflight.com/docs/wiki/" : summary.wiki);

            if (summary.cloudBuild) {
                $('div.release_info #cloudTargetInfo').show();
                $('div.release_info #cloudTargetLog').text('');
                $('div.release_info #cloudTargetStatus').text('pending');
            } else {
                $('div.release_info #cloudTargetInfo').hide();
            }

            if (self.targets) {
                $('div.release_info').slideDown();
                $('.tab-firmware_flasher .content_wrapper').animate({ scrollTop: $('div.release_info').position().top }, 1000);
            }
        }

        function clearBoardConfig() {
            self.config = {};
            self.isConfigLocal = false;
            self.configFilename = null;
        }

        function setBoardConfig(config, filename) {
            self.config = config.join('\n');
            self.isConfigLocal = filename !== undefined;
            self.configFilename = filename !== undefined ? filename : null;
        }

        function processHex(data, key) {
            self.intel_hex = data;

            parseHex(self.intel_hex, function (data) {
                self.parsed_hex = data;

                if (self.parsed_hex) {
                    tracking.setFirmwareData(tracking.DATA.FIRMWARE_SIZE, self.parsed_hex.bytes_total);
                    showLoadedHex(key);
                } else {
                    self.flashingMessage(i18n.getMessage('firmwareFlasherHexCorrupted'), self.FLASH_MESSAGE_TYPES.INVALID);
                    self.enableFlashing(false);
                }
            });
        }

        function onLoadSuccess(data, key) {
            self.localFirmwareLoaded = false;

            processHex(data, key);
            $("a.load_remote_file").removeClass('disabled');
            $("a.load_remote_file").text(i18n.getMessage('firmwareFlasherButtonLoadOnline'));
        }

        function loadTargetList(targets) {
            if (!targets || !navigator.onLine) {
                $('select[name="board"]').empty().append('<option value="0">Offline</option>');
                $('select[name="firmware_version"]').empty().append('<option value="0">Offline</option>');

                return;
            }

            const boards_e = $('select[name="board"]');
            boards_e.empty();
            boards_e.append($(`<option value='0'>${i18n.getMessage("firmwareFlasherOptionLabelSelectBoard")}</option>`));

            const versions_e = $('select[name="firmware_version"]');
            versions_e.empty();
            versions_e.append($(`<option value='0'>${i18n.getMessage("firmwareFlasherOptionLabelSelectFirmwareVersion")}</option>`));

            Object.keys(targets)
                .sort((a,b) => a.target - b.target)
                .forEach(function(target, i) {
                    const descriptor = targets[target];
                    const select_e = $(`<option value='${descriptor.target}'>${descriptor.target}</option>`);
                    boards_e.append(select_e);
                });

            TABS.firmware_flasher.targets = targets;

            result = getStorage('selected_board');
            if (result.selected_board) {
                const selected = targets.find(t => t.target === result.selected_board);
                $('select[name="board"]').val(selected ? result.selected_board : 0).trigger('change');
            }
        }

        function buildOptionsList(select_e, options) {
            select_e.empty();
            options.forEach((option) => {
                if (option.default) {
                    select_e.append($(`<option value='${option.value}' selected>${option.name}</option>`));
                } else {
                    select_e.append($(`<option value='${option.value}'>${option.name}</option>`));
                }
            });
        }

        function buildOptions(data) {
            if (!navigator.onLine) {
                return;
            }
            buildOptionsList($('select[name="radioProtocols"]'), data.radioProtocols);
            buildOptionsList($('select[name="telemetryProtocols"]'), data.telemetryProtocols);
            buildOptionsList($('select[name="options"]'), data.generalOptions);
            buildOptionsList($('select[name="motorProtocols"]'), data.motorProtocols);
        }

        self.releaseLoader.loadOptions(buildOptions);

        let buildTypesToShow;
        const buildType_e = $('select[name="build_type"]');
        function buildBuildTypeOptionsList() {
            buildType_e.empty();
            buildTypesToShow.forEach(({ tag, title }, index) => {
                buildType_e.append($(`<option value='${index}'>${tag ? i18n.getMessage(tag) : title}</option>`));
            });
        }

        const buildTypes = [
            {
                tag: 'firmwareFlasherOptionLabelBuildTypeRelease',
            },
            {
                tag: 'firmwareFlasherOptionLabelBuildTypeReleaseCandidate',
            },
            {
                tag: "firmwareFlasherOptionLabelBuildTypeDevelopment",
            },
        ];

        function showOrHideBuildTypes() {
            const showExtraReleases = $(this).is(':checked');

            if (showExtraReleases) {
                $('tr.build_type').show();
                $('tr.expert_mode').show();
            } else {
                $('tr.build_type').hide();
                $('tr.expert_mode').hide();
                buildType_e.val(0).trigger('change');
            }
        }

        const globalExpertMode_e = $('input[name="expertModeCheckbox"]');
        function showOrHideExpertMode() {
            const expertModeChecked = $(this).is(':checked');

            globalExpertMode_e.prop('checked', expertModeChecked).trigger('change');
            if (expertModeChecked) {
                buildTypesToShow = buildTypes;
            } else {
                buildTypesToShow = buildTypes.slice(0,2);
            }
            buildBuildTypeOptionsList();
            buildType_e.val(0).trigger('change');

            setConfig({'selected_expert_mode': expertModeChecked});
        }

        const expertMode_e = $('.tab-firmware_flasher input.expert_mode');
        const expertMode = getConfig('selected_expert_mode');
        expertMode_e.prop('checked', expertMode.selected_expert_mode ?? false);
        $('input.show_development_releases').change(showOrHideBuildTypes).change();
        expertMode_e.change(showOrHideExpertMode).change();

        // translate to user-selected language
        i18n.localizePage();

        buildType_e.change(function() {
            tracking.setFirmwareData(tracking.DATA.FIRMWARE_CHANNEL, $('option:selected', this).text());

            $("a.load_remote_file").addClass('disabled');
            const build_type = $(this).val();

            $('select[name="board"]').empty()
            .append($(`<option value='0'>${i18n.getMessage("firmwareFlasherOptionLoading")}</option>`));

            $('select[name="firmware_version"]').empty()
            .append($(`<option value='0'>${i18n.getMessage("firmwareFlasherOptionLoading")}</option>`));

            if (!GUI.connect_lock) {
                try {
                    self.releaseLoader.loadTargets(loadTargetList);
                } catch (err) {
                    console.error(err);
                }
            }

            setConfig({'selected_build_type': build_type});
        });

        function selectFirmware(release) {
            $('div.build_configuration').slideUp();
            $('div.release_info').slideUp();

            if (!self.localFirmwareLoaded) {
                self.enableFlashing(false);
                self.flashingMessage(i18n.getMessage('firmwareFlasherLoadFirmwareFile'), self.FLASH_MESSAGE_TYPES.NEUTRAL);
                if (self.parsed_hex && self.parsed_hex.bytes_total) {
                    // Changing the board triggers a version change, so we need only dump it here.
                    console.log('throw out loaded hex');
                    self.intel_hex = undefined;
                    self.parsed_hex = undefined;
                }
            }

            const target = $('select[name="board"] option:selected').val();

            function onTargetDetail(response) {
                self.targetDetail = response;

                if (response.cloudBuild === true) {
                    $('div.build_configuration').slideDown();

                    const expertMode = $('.tab-firmware_flasher input.expert_mode').is(':checked');
                    if (expertMode) {
                        $('div.expertOptions').show();

                        if (response.releaseType === 'Unstable') {
                            self.releaseLoader.loadCommits(response.release, (commits) => {
                                const select_e = $('select[name="commits"]');
                                select_e.empty();
                                commits.forEach((commit) => {
                                    select_e.append($(`<option value='${commit.sha}'>${commit.message}</option>`));
                                });
                            });

                            $('div.commitSelection').show();
                        } else {
                            $('div.commitSelection').hide();
                        }
                    } else {
                        $('div.expertOptions').hide();
                    }
                }

                if (response.configuration && !self.isConfigLocal) {
                    setBoardConfig(response.configuration);
                }

                $("a.load_remote_file").removeClass('disabled');
            }

            self.releaseLoader.loadTarget(target, release, onTargetDetail);
        }

        function populateReleases(versions_element, target) {
            const sortReleases = function (a, b) {
                return -semver.compareBuild(a.release, b.release);
            };

            versions_element.empty();
            const releases = target.releases;
            if (releases.length > 0) {
                versions_element.append(
                    $(
                        `<option value='0'>${i18n.getMessage(
                            "firmwareFlasherOptionLabelSelectFirmwareVersionFor",
                        )} ${target.target}</option>`,
                    ),
                );

                const build_type = $('select[name="build_type"]').val();

                releases
                    .sort(sortReleases)
                    .filter(r => {
                        return (r.type === 'Unstable' && build_type > 1) ||
                               (r.type === 'ReleaseCandidate' && build_type > 0) ||
                               (r.type === 'Stable');
                    })
                    .forEach(function(release) {
                        const releaseName = release.release;

                        const select_e = $(`<option value='${releaseName}'>${releaseName} [${release.label}]</option>`);
                        const summary = `${target}/${release}`;
                        select_e.data('summary', summary);
                        versions_element.append(select_e);
                    });

                // Assume flashing latest, so default to it.
                versions_element.prop("selectedIndex", 1);
                selectFirmware(versions_element.val());
            }
        }

        function clearBufferedFirmware() {
            clearBoardConfig();
            self.intel_hex = undefined;
            self.parsed_hex = undefined;
            self.localFirmwareLoaded = false;
        }

        $('select[name="board"]').select2();
        $('select[name="radioProtocols"]').select2();
        $('select[name="telemetryProtocols"]').select2();
        $('select[name="motorProtocols"]').select2();
        $('select[name="options"]').select2({ closeOnSelect: false });
        $('select[name="commits"]').select2({ tags: true });

        $('select[name="board"]').change(function() {
            $("a.load_remote_file").addClass('disabled');
            let target = $(this).val();

            // exception for board flashed with local custom firmware
            if (target === null) {
                target = '0';
                $(this).val(target).trigger('change');
            }

            if (!GUI.connect_lock) {
                if (target !== '0') {
                    setStorage({'selected_board': target});
                }

                self.selectedBoard = target;
                console.log('board changed to', target);

                self.flashingMessage(i18n.getMessage('firmwareFlasherLoadFirmwareFile'), self.FLASH_MESSAGE_TYPES.NEUTRAL)
                    .flashProgress(0);

                $('div.git_info').slideUp();
                $('div.release_info').slideUp();
                $('div.build_configuration').slideUp();

                if (!self.localFirmwareLoaded) {
                    self.enableFlashing(false);
                }

                const versions_e = $('select[name="firmware_version"]');
                if (target === '0') {
                    // target is 0 is the "Choose a Board" option. Throw out anything loaded
                    clearBufferedFirmware();

                    versions_e.empty();
                    versions_e.append(
                        $(
                            `<option value='0'>${i18n.getMessage(
                                "firmwareFlasherOptionLabelSelectFirmwareVersion",
                            )}</option>`,
                        ),
                    );
                } else {
                    // Show a loading message as there is a delay in loading a configuration
                    versions_e.empty();
                    versions_e.append(
                        $(
                            `<option value='0'>${i18n.getMessage(
                                "firmwareFlasherOptionLoading",
                            )}</option>`,
                        ),
                    );

                    self.releaseLoader.loadTargetReleases(target, (data) => populateReleases(versions_e, data));
                }
            }
        });

        function cleanUnifiedConfigFile(input) {
            let output = [];
            let inComment = false;
            for (let i = 0; i < input.length; i++) {
                if (input.charAt(i) === "\n" || input.charAt(i) === "\r") {
                    inComment = false;
                }

                if (input.charAt(i) === "#") {
                    inComment = true;
                }

                if (!inComment && input.charCodeAt(i) > 255) {
                    self.flashingMessage(i18n.getMessage('firmwareFlasherConfigCorrupted'), self.FLASH_MESSAGE_TYPES.INVALID);
                    gui_log(i18n.getMessage('firmwareFlasherConfigCorruptedLogMessage'));
                    return null;
                }

                if (input.charCodeAt(i) > 255) {
                    output.push('_');
                } else {
                    output.push(input.charAt(i));
                }
            }
            return output.join('').split('\n');
        }

        const portPickerElement = $('div#port-picker #port');
        function flashFirmware(firmware) {
            const options = {};

            let eraseAll = false;
            if ($('input.erase_chip').is(':checked')) {
                options.erase_chip = true;

                eraseAll = true;
            }
            tracking.setFirmwareData(tracking.DATA.FIRMWARE_ERASE_ALL, eraseAll.toString());

            if (!$('option:selected', portPickerElement).data().isDFU) {
                if (String(portPickerElement.val()) !== '0') {
                    const port = String(portPickerElement.val());

                    if ($('input.updating').is(':checked')) {
                        options.no_reboot = true;
                    } else {
                        options.reboot_baud = parseInt($('div#port-picker #baud').val());
                    }

                    let baud = 115200;
                    if ($('input.flash_manual_baud').is(':checked')) {
                        baud = parseInt($('#flash_manual_baud_rate').val());
                    }

                    tracking.sendEvent(tracking.EVENT_CATEGORIES.FLASHING, 'Flashing', self.fileName || null);

                    STM32.connect(port, baud, firmware, options);
                } else {
                    console.log('Please select valid serial port');
                    gui_log(i18n.getMessage('firmwareFlasherNoValidPort'));
                }
            } else {
                tracking.sendEvent(tracking.EVENT_CATEGORIES.FLASHING, 'Flashing', self.fileName || null);

                STM32DFU.connect(usbDevices, firmware, options);
            }
        }

        function verifyBoard() {
            if (!$('option:selected', portPickerElement).data().isDFU) {

                function onFinishClose() {
                    MSP.clearListeners();
                }

                function onClose() {
                    serial.disconnect(onFinishClose);
                    MSP.disconnect_cleanup();
                }

                function onFinish() {
                    const board = FC.CONFIG.boardName;
                    const boardSelect = $('select[name="board"]');
                    const boardSelectOptions = $('select[name="board"] option');
                    const target = boardSelect.val();
                    let targetAvailable = false;

                    if (board) {
                        boardSelectOptions.each((_, e) => {
                            if ($(e).text() === board) {
                                targetAvailable = true;
                            }
                        });

                        if (board !== target) {
                            boardSelect.val(board).trigger('change');
                        }
                        gui_log(i18n.getMessage(targetAvailable ? 'firmwareFlasherBoardVerificationSuccess' : 'firmwareFlasherBoardVerficationTargetNotAvailable',
                            { boardName: board }));
                    } else {
                        gui_log(i18n.getMessage('firmwareFlasherBoardVerificationFail'));
                    }
                    onClose();
                }

                function getBoard() {
                    console.log(`Requesting board information`);
                    MSP.send_message(MSPCodes.MSP_API_VERSION, false, false, () => {
                        if (!FC.CONFIG.apiVersion || FC.CONFIG.apiVersion === 'null.null.0') {
                            FC.CONFIG.apiVersion = '0.0.0';
                        }
                        console.log(FC.CONFIG.apiVersion);
                        MSP.send_message(MSPCodes.MSP_UID, false, false, () => {
                            if (semver.gte(FC.CONFIG.apiVersion, API_VERSION_1_39)) {
                                MSP.send_message(MSPCodes.MSP_BOARD_INFO, false, false, onFinish);
                            } else {
                                console.log('Firmware version not supported for reading board information');
                                onClose();
                            }
                        });
                    });
                }

                function onConnect(openInfo) {
                    if (openInfo) {
                        serial.onReceive.addListener(data => MSP.read(data));
                        const mspHelper = new MspHelper();
                        MSP.listen(mspHelper.process_data.bind(mspHelper));
                        getBoard();
                    } else {
                        gui_log(i18n.getMessage('serialPortOpenFail'));
                    }
                }

                // Can only verify if not in DFU mode.
                if (String(portPickerElement.val()) !== '0') {
                    const port = String(portPickerElement.val());
                    let baud = 115200;

                    if ($('input.flash_manual_baud').is(':checked')) {
                        baud = parseInt($('#flash_manual_baud_rate').val());
                    }

                    gui_log(i18n.getMessage('firmwareFlasherDetectBoardQuery'));

                    const isLoaded = self.targets ? Object.keys(self.targets).length > 0 : false;

                    if (isLoaded) {
                        if (!(serial.connected || serial.connectionId)) {
                            serial.connect(port, {bitrate: baud}, onConnect);
                        } else {
                            console.warn('Attempting to connect while there still is a connection', serial.connected, serial.connectionId);
                            serial.disconnect();
                        }
                    } else {
                        console.log('Releases not loaded yet');
                    }
                } else {
                    gui_log(i18n.getMessage('firmwareFlasherNoValidPort'));
                }
            }
        }

        const detectBoardElement = $('a.detect-board');

        detectBoardElement.on('click', () => {
            detectBoardElement.addClass('disabled');

            verifyBoard();

            setTimeout(() => detectBoardElement.removeClass('disabled'), 1000);
        });

        function updateDetectBoardButton() {
            const isDfu = PortHandler.dfu_available;
            const isBusy = GUI.connect_lock;
            const isAvailable = PortHandler.port_available;
            const isButtonDisabled = isDfu || isBusy || !isAvailable;

            detectBoardElement.toggleClass('disabled', isButtonDisabled);
        }

        let result = getConfig('erase_chip');
        if (result.erase_chip) {
            $('input.erase_chip').prop('checked', true);
        } else {
            $('input.erase_chip').prop('checked', false);
        }

        $('input.erase_chip').change(function () {
            setConfig({'erase_chip': $(this).is(':checked')});
        }).change();

        result = getConfig('show_development_releases');
        $('input.show_development_releases')
        .prop('checked', result.show_development_releases)
        .change(function () {
            setConfig({'show_development_releases': $(this).is(':checked')});
        }).change();

        result = getConfig('selected_build_type');
        // ensure default build type is selected
        buildType_e.val(result.selected_build_type || 0).trigger('change');

        result = getConfig('no_reboot_sequence');
        if (result.no_reboot_sequence) {
            $('input.updating').prop('checked', true);
            $('.flash_on_connect_wrapper').show();
        } else {
            $('input.updating').prop('checked', false);
        }

        // bind UI hook so the status is saved on change
        $('input.updating').change(function() {
            const status = $(this).is(':checked');

            if (status) {
                $('.flash_on_connect_wrapper').show();
            } else {
                $('input.flash_on_connect').prop('checked', false).change();
                $('.flash_on_connect_wrapper').hide();
            }

            setConfig({'no_reboot_sequence': status});
        });

        $('input.updating').change();

        result = getConfig('flash_manual_baud');
        if (result.flash_manual_baud) {
            $('input.flash_manual_baud').prop('checked', true);
        } else {
            $('input.flash_manual_baud').prop('checked', false);
        }

        $('input.corebuild_mode').change(function () {
            const status = $(this).is(':checked');

            $('.hide-in-core-build-mode').toggle(!status);
        });
        $('input.corebuild_mode').change();

        // bind UI hook so the status is saved on change
        $('input.flash_manual_baud').change(function() {
            const status = $(this).is(':checked');
            setConfig({'flash_manual_baud': status});
        });

        $('input.flash_manual_baud').change();

        result = getConfig('flash_manual_baud_rate');
        $('#flash_manual_baud_rate').val(result.flash_manual_baud_rate);

        // bind UI hook so the status is saved on change
        $('#flash_manual_baud_rate').change(function() {
            const baud = parseInt($('#flash_manual_baud_rate').val());
            setConfig({'flash_manual_baud_rate': baud});
        });

        $('input.flash_manual_baud_rate').change();

        // UI Hooks
        $('a.load_file').click(function () {
            self.enableFlashing(false);
            self.developmentFirmwareLoaded = false;

            tracking.setFirmwareData(tracking.DATA.FIRMWARE_CHANNEL, undefined);
            tracking.setFirmwareData(tracking.DATA.FIRMWARE_SOURCE, 'file');

            chrome.fileSystem.chooseEntry({
                type: 'openFile',
                accepts: [
                    {
                        description: 'target files',
                        extensions: ['hex', 'config'],
                    },
                ],
            }, function (fileEntry) {
                if (checkChromeRuntimeError()) {
                    return;
                }

                // hide github info (if it exists)
                $('div.git_info').slideUp();
                $('div.build_configuration').slideUp();

                chrome.fileSystem.getDisplayPath(fileEntry, function (path) {
                    console.log('Loading file from:', path);

                    fileEntry.file(function (file) {
                        tracking.setFirmwareData(tracking.DATA.FIRMWARE_NAME, file.name);
                        const reader = new FileReader();

                        reader.onloadend = function(e) {
                            if (e.total !== 0 && e.total === e.loaded) {
                                console.log(`File loaded (${e.loaded})`);

                                if (file.name.split('.').pop() === "hex") {
                                    self.intel_hex = e.target.result;

                                    parseHex(self.intel_hex, function (data) {
                                        self.parsed_hex = data;

                                        if (self.parsed_hex) {
                                            tracking.setFirmwareData(tracking.DATA.FIRMWARE_SIZE, self.parsed_hex.bytes_total);
                                            self.localFirmwareLoaded = true;

                                            showLoadedHex(file.name);
                                        } else {
                                            self.flashingMessage(i18n.getMessage('firmwareFlasherHexCorrupted'), self.FLASH_MESSAGE_TYPES.INVALID);
                                        }
                                    });
                                } else {
                                    clearBufferedFirmware();

                                    let config = cleanUnifiedConfigFile(e.target.result);
                                    if (config !== null) {
                                        setBoardConfig(config, file.name);

                                        if (self.isConfigLocal && !self.parsed_hex) {
                                            self.flashingMessage(i18n.getMessage('firmwareFlasherLoadedConfig'), self.FLASH_MESSAGE_TYPES.NEUTRAL);
                                        }

                                        if ((self.isConfigLocal && self.parsed_hex && !self.localFirmwareLoaded) || self.localFirmwareLoaded) {
                                            self.enableFlashing(true);
                                            self.flashingMessage(i18n.getMessage('firmwareFlasherFirmwareLocalLoaded', self.parsed_hex.bytes_total), self.FLASH_MESSAGE_TYPES.NEUTRAL);
                                        }
                                    }
                                }
                            }
                        };

                        reader.readAsText(file);
                    });
                });
            });
        });

        /**
         * Lock / Unlock the firmware download button according to the firmware selection dropdown.
         */
        $('select[name="firmware_version"]').change((evt) => {
                selectFirmware($("option:selected", evt.target).val());
            },
        );

        $('a.load_remote_file').click(function (evt) {
            self.enableFlashing(false);
            self.localFirmwareLoaded = false;
            self.developmentFirmwareLoaded = buildTypesToShow[$('select[name="build_type"]').val()].tag === 'firmwareFlasherOptionLabelBuildTypeDevelopment';

            tracking.setFirmwareData(tracking.DATA.FIRMWARE_SOURCE, 'http');

            if ($('select[name="firmware_version"]').val() === "0") {
                gui_log(i18n.getMessage('firmwareFlasherNoFirmwareSelected'));
                return;
            }

            function onLoadFailed() {
                $('span.progressLabel').attr('i18n','firmwareFlasherFailedToLoadOnlineFirmware').removeClass('i18n-replaced');
                $("a.load_remote_file").removeClass('disabled');
                $("a.load_remote_file").text(i18n.getMessage('firmwareFlasherButtonLoadOnline'));
                i18n.localizePage();
            }

            function updateStatus(status, key, val, showLog) {
                if (showLog === true) {
                    $('div.release_info #cloudTargetLog').text(i18n.getMessage(`firmwareFlasherCloudBuildLogUrl`)).prop('href', `https://build.betaflight.com/api/builds/${key}/log`);
                }
                $('div.release_info #cloudTargetStatus').text(i18n.getMessage(`firmwareFlasherCloudBuild${status}`));
                $('.buildProgress').val(val);
            }

            function processBuildStatus(response, statusResponse, retries) {
                if (statusResponse.status === 'success') {
                    updateStatus(retries <= 0 ? 'SuccessCached' : "Success", response.key, 100, true);
                    if (statusResponse.configuration !== undefined && !self.isConfigLocal) {
                        setBoardConfig(statusResponse.configuration);
                    }
                    self.releaseLoader.loadTargetHex(response.url, (hex) => onLoadSuccess(hex, response.file), onLoadFailed);
                } else {
                    updateStatus(retries > 10 ? 'TimedOut' : "Failed", response.key, 0, true);
                    onLoadFailed();
                }
            }

            function requestCloudBuild(targetDetail) {
                let request = {
                    target: targetDetail.target,
                    release: targetDetail.release,
                    options: [],
                    client: {
                        version: CONFIGURATOR.version,
                    },
                };

                const coreBuild = (targetDetail.cloudBuild !== true) || $('input[name="coreBuildModeCheckbox"]').is(':checked');
                if (coreBuild === true) {
                    request.options.push("CORE_BUILD");
                } else {
                    request.options.push("CLOUD_BUILD");
                    $('select[name="radioProtocols"] option:selected').each(function () {
                        request.options.push($(this).val());
                    });

                    $('select[name="telemetryProtocols"] option:selected').each(function () {
                        request.options.push($(this).val());
                    });

                    $('select[name="options"] option:selected').each(function () {
                        request.options.push($(this).val());
                    });

                    $('select[name="motorProtocols"] option:selected').each(function () {
                        request.options.push($(this).val());
                    });

                    if ($('input[name="expertModeCheckbox"]').is(':checked')) {
                        if (targetDetail.releaseType === "Unstable") {
                            request.commit = $('select[name="commits"] option:selected').val();
                        }

                        $('input[name="customDefines"]').val().split(' ').map(element => element.trim()).forEach(v => {
                            request.options.push(v);
                        });
                    }
                }

                console.info("Build request:", request);
                self.releaseLoader.requestBuild(request, (response) => {
                    console.info("Build response:", response);

                    // Complete the summary object to be used later
                    self.targetDetail.file = response.file;

                    if (!targetDetail.cloudBuild) {
                        // it is a previous release, so simply load the hex
                        self.releaseLoader.loadTargetHex(response.url, (hex) => onLoadSuccess(hex, response.file), onLoadFailed);
                        return;
                    }

                    tracking.setFirmwareData(tracking.DATA.FIRMWARE_NAME, response.file);

                    updateStatus('Pending', response.key, 0, false);

                    let retries = 1;
                    self.releaseLoader.requestBuildStatus(response.key, (statusResponse) => {
                        if (statusResponse.status !== "queued") {
                            // will be cached already, no need to wait.
                            processBuildStatus(response, statusResponse, 0);
                            return;
                        }

                        const timer = setInterval(() => {
                            self.releaseLoader.requestBuildStatus(response.key, (statusResponse) => {
                                if (statusResponse.status !== 'queued' || retries > 10) {
                                    clearInterval(timer);
                                    processBuildStatus(response, statusResponse, retries);
                                    return;
                                }

                                updateStatus('Processing', response.key, retries * 10, false);
                                retries = retries + 1;
                            });
                        }, 4000);
                    });
                }, onLoadFailed);
            }

            if (self.targetDetail) { // undefined while list is loading or while running offline
                $("a.load_remote_file").text(i18n.getMessage('firmwareFlasherButtonDownloading'));
                $("a.load_remote_file").addClass('disabled');

                showReleaseNotes(self.targetDetail);

                requestCloudBuild(self.targetDetail);
            } else {
                $('span.progressLabel').attr('i18n','firmwareFlasherFailedToLoadOnlineFirmware').removeClass('i18n-replaced');
                i18n.localizePage();
            }
        });

        const exitDfuElement = $('a.exit_dfu');

        exitDfuElement.click(function () {
            if (!exitDfuElement.hasClass('disabled')) {
                exitDfuElement.addClass("disabled");
                if (!GUI.connect_lock) { // button disabled while flashing is in progress
                    tracking.sendEvent(tracking.EVENT_CATEGORIES.FLASHING, 'ExitDfu', null);
                    try {
                        console.log('Closing DFU');
                        STM32DFU.connect(usbDevices, self.parsed_hex, { exitDfu: true });
                    } catch (e) {
                        console.log(`Exiting DFU failed: ${e.message}`);
                    }
                }
            }
        });

        portPickerElement.on('change', function () {
            if (GUI.active_tab === 'firmware_flasher') {
                if (!GUI.connect_lock) {
                    if ($('option:selected', this).data().isDFU) {
                        exitDfuElement.removeClass('disabled');
                    } else {
                        // Porthandler resets board on port detect
                        if (self.boardNeedsVerification) {
                            // reset to prevent multiple calls
                            self.boardNeedsVerification = false;
                            verifyBoard();
                        }

                        $("a.load_remote_file").removeClass('disabled');
                        $("a.load_file").removeClass('disabled');
                        exitDfuElement.addClass('disabled');
                    }
                }
                updateDetectBoardButton();
            }
        }).trigger('change');

        $('a.flash_firmware').click(function () {
            if (!$(this).hasClass('disabled')) {
                if (self.developmentFirmwareLoaded) {
                    checkShowAcknowledgementDialog();
                } else {
                    startFlashing();
                }
            }
        });

        function checkShowAcknowledgementDialog() {
            const DAY_MS = 86400 * 1000;
            const storageTag = 'lastDevelopmentWarningTimestamp';

            function setAcknowledgementTimestamp() {
                const storageObj = {};
                storageObj[storageTag] = Date.now();
                setStorage(storageObj);
            }

            result = getStorage(storageTag);
            if (!result[storageTag] || Date.now() - result[storageTag] > DAY_MS) {

                showAcknowledgementDialog(setAcknowledgementTimestamp);
            } else {
                startFlashing();
            }
        }

        function showAcknowledgementDialog(acknowledgementCallback) {
            const dialog = $('#dialogUnstableFirmwareAcknowledgement')[0];
            const flashButtonElement = $('#dialogUnstableFirmwareAcknowledgement-flashbtn');
            const acknowledgeCheckboxElement = $('input[name="dialogUnstableFirmwareAcknowledgement-acknowledge"]');

            acknowledgeCheckboxElement.change(function () {
                if ($(this).is(':checked')) {
                    flashButtonElement.removeClass('disabled');
                } else {
                    flashButtonElement.addClass('disabled');
                }
            });

            flashButtonElement.click(function() {
                dialog.close();

                if (acknowledgeCheckboxElement.is(':checked')) {
                    if (acknowledgementCallback) {
                        acknowledgementCallback();
                    }

                    startFlashing();
                }
            });

            $('#dialogUnstableFirmwareAcknowledgement-cancelbtn').click(function() {
                dialog.close();
            });

            dialog.addEventListener('close', function () {
                acknowledgeCheckboxElement.prop('checked', false).change();
            });

            dialog.showModal();
        }

        function startFlashing() {
            exitDfuElement.addClass('disabled');
            $('a.flash_firmware').addClass('disabled');
            $("a.load_remote_file").addClass('disabled');
            $("a.load_file").addClass('disabled');
            if (!GUI.connect_lock) { // button disabled while flashing is in progress
                if (self.parsed_hex) {
                    try {
                        if (self.config && !self.parsed_hex.configInserted) {
                            const configInserter = new ConfigInserter();

                            if (configInserter.insertConfig(self.parsed_hex, self.config)) {
                                self.parsed_hex.configInserted = true;
                            } else {
                                console.log('Firmware does not support custom defaults.');
                                clearBoardConfig();
                            }
                        }

                        flashFirmware(self.parsed_hex);
                    } catch (e) {
                        console.log(`Flashing failed: ${e.message}`);
                    }
                } else {
                    $('span.progressLabel').attr('i18n','firmwareFlasherFirmwareNotLoaded').removeClass('i18n-replaced');
                    i18n.localizePage();
                }
            }
        }

        $('span.progressLabel').on('click', 'a.save_firmware', function () {
            chrome.fileSystem.chooseEntry({type: 'saveFile', suggestedName: self.targetDetail.file, accepts: [{description: 'HEX files', extensions: ['hex']}]}, function (fileEntry) {
                if (checkChromeRuntimeError()) {
                    return;
                }

                chrome.fileSystem.getDisplayPath(fileEntry, function (path) {
                    console.log('Saving firmware to:', path);

                    // check if file is writable
                    chrome.fileSystem.isWritableEntry(fileEntry, function (isWritable) {
                        if (isWritable) {
                            const blob = new Blob([self.intel_hex], {type: 'text/plain'});

                            fileEntry.createWriter(function (writer) {
                                let truncated = false;

                                writer.onerror = function (e) {
                                    console.error(e);
                                };

                                writer.onwriteend = function() {
                                    if (!truncated) {
                                        // onwriteend will be fired again when truncation is finished
                                        truncated = true;
                                        writer.truncate(blob.size);

                                        return;
                                    }

                                    tracking.sendEvent(tracking.EVENT_CATEGORIES.FLASHING, 'SaveFirmware', path);
                                };

                                writer.write(blob);
                            }, function (e) {
                                console.error(e);
                            });
                        } else {
                            console.log('You don\'t have write permissions for this file, sorry.');
                            gui_log(i18n.getMessage('firmwareFlasherWritePermissions'));
                        }
                    });
                });
            });
        });

        $('input.flash_on_connect').change(function () {
            const status = $(this).is(':checked');

            if (status) {
                const catch_new_port = function () {
                    PortHandler.port_detected('flash_detected_device', function (resultPort) {
                        const port = resultPort[0];

                        if (!GUI.connect_lock) {
                            gui_log(i18n.getMessage('firmwareFlasherFlashTrigger', [port]));
                            console.log(`Detected: ${port} - triggering flash on connect`);

                            // Trigger regular Flashing sequence
                            GUI.timeout_add('initialization_timeout', function () {
                                $('a.flash_firmware').click();
                            }, 100); // timeout so bus have time to initialize after being detected by the system
                        } else {
                            gui_log(i18n.getMessage('firmwareFlasherPreviousDevice', [port]));
                        }

                        // Since current port_detected request was consumed, create new one
                        catch_new_port();
                    }, false, true);
                };

                catch_new_port();
            } else {
                PortHandler.flush_callbacks();
            }
        }).change();

        $(document).keypress(function (e) {
            if (e.which === 13) { // enter
                // Trigger regular Flashing sequence
                $('a.flash_firmware').click();
            }
        });

        self.flashingMessage(i18n.getMessage('firmwareFlasherLoadFirmwareFile'), self.FLASH_MESSAGE_TYPES.NEUTRAL);

        // Update Firmware button at top
        $('div#flashbutton a.flash_state').addClass('active');
        $('div#flashbutton a.flash').addClass('active');
        GUI.content_ready(callback);
    }

    self.releaseLoader.loadTargets(() => {
       $('#content').load("./tabs/firmware_flasher.html", onDocumentLoad);
    });
};

firmware_flasher.cleanup = function (callback) {
    PortHandler.flush_callbacks();

    // unbind "global" events
    $(document).unbind('keypress');
    $(document).off('click', 'span.progressLabel a');

    // Update Firmware button at top
    $('div#flashbutton a.flash_state').removeClass('active');
    $('div#flashbutton a.flash').removeClass('active');

    tracking.resetFirmwareData();

    if (callback) callback();
};

firmware_flasher.enableFlashing = function (enabled) {
    if (enabled) {
        $('a.flash_firmware').removeClass('disabled');
    } else {
        $('a.flash_firmware').addClass('disabled');
    }
};

firmware_flasher.refresh = function (callback) {
    const self = this;

    GUI.tab_switch_cleanup(function() {
        self.initialize();

        if (callback) {
            callback();
        }
    });
};

firmware_flasher.showDialogVerifyBoard = function (selected, verified, onAbort, onAccept) {
    const dialogVerifyBoard = $('#dialog-verify-board')[0];

    $('#dialog-verify-board-content').html(i18n.getMessage('firmwareFlasherVerifyBoard', {selected_board: selected, verified_board: verified}));

    if (!dialogVerifyBoard.hasAttribute('open')) {
        dialogVerifyBoard.showModal();
        $('#dialog-verify-board-abort-confirmbtn').click(function() {
            setStorage({'selected_board': FC.CONFIG.boardName});
            dialogVerifyBoard.close();
            onAbort();
        });
        $('#dialog-verify-board-continue-confirmbtn').click(function() {
            dialogVerifyBoard.close();
            onAccept();
        });
    }
};

firmware_flasher.FLASH_MESSAGE_TYPES = {
    NEUTRAL : 'NEUTRAL',
    VALID   : 'VALID',
    INVALID : 'INVALID',
    ACTION  : 'ACTION',
};

firmware_flasher.flashingMessage = function(message, type) {
    let self = this;

    let progressLabel_e = $('span.progressLabel');
    switch (type) {
        case self.FLASH_MESSAGE_TYPES.VALID:
            progressLabel_e.removeClass('invalid actionRequired')
                           .addClass('valid');
            break;
        case self.FLASH_MESSAGE_TYPES.INVALID:
            progressLabel_e.removeClass('valid actionRequired')
                           .addClass('invalid');
            break;
        case self.FLASH_MESSAGE_TYPES.ACTION:
            progressLabel_e.removeClass('valid invalid')
                           .addClass('actionRequired');
            break;
        case self.FLASH_MESSAGE_TYPES.NEUTRAL:
        default:
            progressLabel_e.removeClass('valid invalid actionRequired');
            break;
    }
    if (message !== null) {
        progressLabel_e.html(message);
    }

    return self;
};

firmware_flasher.flashProgress = function(value) {
    $('.progress').val(value);

    return this;
};

firmware_flasher.injectTargetInfo = function (targetConfig, targetName, manufacturerId, commitInfo) {
    const targetInfoLineRegex = /^# config: manufacturer_id: .*, board_name: .*, version: .*$, date: .*\n/gm;

    const config = targetConfig.replace(targetInfoLineRegex, '');

    const targetInfo = `# config: manufacturer_id: ${manufacturerId}, board_name: ${targetName}, version: ${commitInfo.commitHash}, date: ${commitInfo.date}`;

    const lines = config.split('\n');
    lines.splice(1, 0, targetInfo);
    return lines.join('\n');
};

TABS.firmware_flasher = firmware_flasher;

export {
    firmware_flasher,
};
