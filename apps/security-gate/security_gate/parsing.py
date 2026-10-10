"""Read bounded regular files and validate YAML before safe_load."""
import os
import stat

import yaml
from yaml.nodes import MappingNode, ScalarNode, SequenceNode
from yaml.tokens import (AliasToken, AnchorToken, TagToken, BlockMappingStartToken,
                         BlockSequenceStartToken, FlowMappingStartToken,
                         FlowSequenceStartToken, BlockEndToken,
                         FlowMappingEndToken, FlowSequenceEndToken)

from .discovery import is_link
from .models import ScanError

MAX_YAML_TOKENS = 100_000
MAX_YAML_DEPTH = 64


def read_bounded_bytes(path, max_bytes):
    before = path.lstat()
    if is_link(before):
        raise ScanError("SYMLINK_OR_REPARSE_POINT")
    if not stat.S_ISREG(before.st_mode):
        raise ScanError("UNSUPPORTED_PATH_TYPE")
    if before.st_size > max_bytes:
        raise ScanError("FILE_SIZE_LIMIT_EXCEEDED")
    flags = os.O_RDONLY | getattr(os, "O_BINARY", 0) | getattr(os, "O_NOFOLLOW", 0)
    fd = os.open(path, flags)
    with os.fdopen(fd, "rb") as stream:
        opened = os.fstat(stream.fileno())
        if (is_link(opened) or not stat.S_ISREG(opened.st_mode)
                or (before.st_dev, before.st_ino) != (opened.st_dev, opened.st_ino)):
            raise ScanError("FILE_CHANGED_OR_UNSAFE")
        data = stream.read(max_bytes + 1)
        if len(data) > max_bytes:
            raise ScanError("FILE_SIZE_LIMIT_EXCEEDED")
    return data


def read_bounded(path, max_bytes):
    return read_bounded_bytes(path, max_bytes).decode("utf-8-sig")


def parse(source):
    depth = 0
    starts = (BlockMappingStartToken, BlockSequenceStartToken,
              FlowMappingStartToken, FlowSequenceStartToken)
    ends = (BlockEndToken, FlowMappingEndToken, FlowSequenceEndToken)
    for count, token in enumerate(yaml.scan(source, Loader=yaml.SafeLoader), 1):
        if count > MAX_YAML_TOKENS:
            raise ScanError("YAML_COMPLEXITY_LIMIT_EXCEEDED")
        if isinstance(token, (AliasToken, AnchorToken)):
            raise ScanError("YAML_REFERENCES_UNSUPPORTED")
        if isinstance(token, TagToken):
            raise ScanError("YAML_EXPLICIT_TAG_UNSUPPORTED")
        if isinstance(token, starts):
            depth += 1
            if depth > MAX_YAML_DEPTH:
                raise ScanError("YAML_COMPLEXITY_LIMIT_EXCEEDED")
        elif isinstance(token, ends):
            depth -= 1
    root = yaml.compose(source, Loader=yaml.SafeLoader)
    pending = [root] if root else []
    while pending:
        node = pending.pop()
        if isinstance(node, MappingNode):
            keys = set()
            for key, value in node.value:
                if not isinstance(key, ScalarNode) or key.tag != "tag:yaml.org,2002:str":
                    raise ScanError("YAML_INVALID_MAPPING_KEY")
                if key.value in keys:
                    raise ScanError("YAML_DUPLICATE_KEY")
                keys.add(key.value)
                pending.append(value)
        elif isinstance(node, SequenceNode):
            pending.extend(node.value)
    # Only safe_load constructs values; targets are never imported or executed.
    return yaml.safe_load(source), root


def mapping_value(node, name):
    if isinstance(node, MappingNode):
        return next((value for key, value in node.value if key.value == name), None)
    return None
